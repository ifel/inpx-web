const fs = require('fs-extra');
const path = require('path');

const express = require('express');
const http = require('http');
const WebSocket = require ('ws');

const opds = require('./core/opds');
const utils = require('./core/utils');

const ayncExit = new (require('./core/AsyncExit'))();

let log;
let config;
let argv;
let branch = '';
const argvStrings = ['host', 'port', 'app-dir', 'lib-dir', 'inpx'];

function showHelp(defaultConfig) {
    console.log(utils.versionText(config));
    console.log(
`Usage: ${config.name} [options]

Options:
  --help              Print ${config.name} command line options
  --host=<ip>         Set web server host, default: ${defaultConfig.server.host}
  --port=<port>       Set web server port, default: ${defaultConfig.server.port}
  --app-dir=<dirpath> Set application working directory, default: <execDir>/.${config.name}
  --lib-dir=<dirpath> Set library directory, default: the same as ${config.name} executable's
  --inpx=<filepath>   Set INPX collection file, default: the one that found in library dir
  --recreate          Force recreation of the search database on start
`
    );
}

async function init() {
    argv = require('minimist')(process.argv.slice(2), {string: argvStrings});
    const dataDir = argv['app-dir'];

    //config
    const configManager = new (require('./config'))();//singleton
    await configManager.init(dataDir);
    const defaultConfig = configManager.config;

    await configManager.load();
    config = configManager.config;
    branch = config.branch;

    //dirs
    config.tempDir = `${config.dataDir}/tmp`;
    config.logDir = `${config.dataDir}/log`;
    config.publicDir = `${config.dataDir}/public`;
    config.publicFilesDir = `${config.dataDir}/public-files`;
    config.filesPathStatic = `/book`;
    config.filesDir = `${config.publicFilesDir}${config.filesPathStatic}`;

    configManager.config = config;

    await fs.ensureDir(config.dataDir);
    await fs.ensureDir(config.filesDir);
    await fs.ensureDir(config.tempDir);
    await fs.emptyDir(config.tempDir);

    //logger
    const appLogger = new (require('./core/AppLogger'))();//singleton
    await appLogger.init(config);
    log = appLogger.log;

    //cli
    if (argv.help) {
        showHelp(defaultConfig);
        ayncExit.exit(0);
    } else {
        log(utils.versionText(config));
        log('Initializing');
    }

    if (argv.host) {
        config.server.host = argv.host;
    }

    if (argv.port) {
        config.server.port = argv.port;
    }

    if (!config.remoteLib) {
        const libDir = argv['lib-dir'];
        if (libDir) {
            if (await fs.pathExists(libDir)) {
                config.libDir = libDir;
            } else {
                throw new Error(`Directory "${libDir}" not exists`);
            }
        } else {
            config.libDir = config.execDir;
        }

        if (argv.inpx) {
            if (await fs.pathExists(argv.inpx)) {
                config.inpxFile = argv.inpx;
            } else {
                throw new Error(`File "${argv.inpx}" not found`);
            }
        } else {
            const inpxFiles = [];
            await utils.findFiles((file) => {
                if (path.extname(file) == '.inpx')
                    inpxFiles.push(file);
            }, config.libDir, false);

            if (inpxFiles.length) {
                if (inpxFiles.length == 1) {
                    config.inpxFile = inpxFiles[0];
                } else {
                    throw new Error(`Found more than one .inpx files: \n${inpxFiles.join('\n')}`);
                }
            } else {
                throw new Error(`No .inpx files found here: ${config.libDir}`);
            }
        }
    } else {
        config.inpxFile = `${config.dataDir}/remote.inpx`;
        const RemoteLib = require('./core/RemoteLib');//singleton
        const remoteLib = new RemoteLib(config);
        await remoteLib.downloadInpxFile();
    }

    config.recreateDb = argv.recreate || false;
    config.inpxFilterFile = `${config.dataDir}/filter.json`;
    config.allowUnsafeFilter = argv['unsafe-filter'] || false;

    //web app
    if (branch !== 'development') {
        const createWebApp = require('./createWebApp');
        await createWebApp(config);
    }
}

async function main() {
    const log = new (require('./core/AppLogger'))().log;//singleton

    //server
    const app = express();

    const server = http.createServer(app);
    const wss = new WebSocket.Server({ server, maxPayload: config.maxPayloadSize*1024*1024 });

    let devModule = undefined;
    if (branch == 'development') {
        const devFileName = './dev.js'; //require ignored by pkg -50Mb executable size
        devModule = require(devFileName);
        devModule.webpackDevMiddleware(app);
    }

    if (devModule)
        devModule.logQueries(app);

    opds(app, config);
    initStatic(app, config);
    
    const { WebSocketController } = require('./controllers');
    new WebSocketController(wss, config);

    if (devModule) {
        devModule.logErrors(app);
    } else {
        app.use(function(err, req, res, next) {// eslint-disable-line no-unused-vars
            log(LM_ERR, err.stack);
            res.sendStatus(500);
        });
    }

    server.listen(config.server.port, config.server.host, () => {
        config.server.ready = true;
        log(`Server ready`);
    });
}

function initStatic(app, config) {
    /*
    publicFilesDir = `${config.dataDir}/public-files`;
    filesPathStatic = `/book`;
    filesDir = `${config.publicFilesDir}${config.filesPathStatic}`;
    */
    const filesPath = `${config.filesPathStatic}/`;
    //загрузка или восстановление файлов в /files, при необходимости
    app.use(async(req, res, next) => {
        if ((req.method !== 'GET' && req.method !== 'HEAD') ||
            !(req.path.indexOf(filesPath) === 0)
            ) {
            return next();
        }

        if (path.extname(req.path) == '') {
            const bookFile = `${config.publicFilesDir}${req.path}`;
            const bookFileDesc = `${bookFile}.d.json`;

            let downFileName = '';
            //восстановим из json-файла описания
            try {
                if (await fs.pathExists(bookFile) && await fs.pathExists(bookFileDesc)) {
                    await utils.touchFile(bookFile);
                    await utils.touchFile(bookFileDesc);

                    let desc = await fs.readFile(bookFileDesc, 'utf8');
                    desc = JSON.parse(desc);
                    downFileName = desc.downFileName;
                } else {
                    await fs.remove(bookFile);
                    await fs.remove(bookFileDesc);
                }
            } catch(e) {
                log(LM_ERR, e.message);
            }

            if (downFileName)
                res.downFileName = downFileName;
        }

        return next();
    });

    //заголовки при отдаче
    app.use(config.filesPathStatic, express.static(config.filesDir, {
        setHeaders: (res) => {
            if (res.downFileName) {
                res.set('Content-Encoding', 'gzip');
                res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(res.downFileName)}`);
            }
        },
    }));

    app.use(express.static(config.publicDir));
}

(async() => {
    try {
        await init();
        await main();
    } catch (e) {
        const mes = (branch == 'development' ? e.stack : e.message);
        if (log)
            log(LM_FATAL, mes);
        else
            console.error(mes);

        ayncExit.exit(1);
    }
})();
