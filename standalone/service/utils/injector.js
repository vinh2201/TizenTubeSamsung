// The TizenBrew-way of TizenTube. Uses CDP and SDB to inject the userscript.

const adbhost = require('adbhost');
const CDP = require('chrome-remote-interface');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');


var isConnecting = false;
const isTizen3 = tizen.systeminfo.getCapability('http://tizen.org/feature/platform.version').startsWith('3.0');

// ---------------------------------------------------------------------------
// Local userScript.js (shipped inside the .wgt) instead of the jsDelivr CDN.
//
// The page that runs TizenTube is served from youtube.com (or localhost), so it
// can never read a file inside the .wgt directly. This service (Node) is the one
// that reads the file; it then hands the code to the page:
//   - injector.js (CDP):          Runtime.evaluate(code)
//   - index.js (proxy):           same-origin route  /tizentube/userScript.js
//   - cobaltProxyServer.js (MITM): same-origin route  /__tizentube/userScript.js
//
// Where is the file? Starting from this file's folder (and the process cwd) we walk
// up a few levels and look for  scripts/userScript.js  (also script/, service/scripts/,
// service/script/). That works whether this file is in service/ or service/utils/, so
// the exact wgt layout doesn't matter much.
//
// The path is built at runtime on purpose (no literal in fs.readFileSync), so
// @vercel/ncc does not try to treat the file as an asset at build time.
// ---------------------------------------------------------------------------
const USERSCRIPT_SUBPATHS = [
    'scripts/userScript.js',          // folder used by the GitHub workflow (standalone/service/scripts)
    'script/userScript.js',
    'service/scripts/userScript.js',  // when walking up to the wgt root / repo root
    'service/script/userScript.js'
];
const USERSCRIPT_MAX_LEVELS_UP = 5;

function getUserScriptStartDirs() {
    const starts = [];
    [__dirname, process.cwd()].forEach(dir => {
        const full = path.resolve(dir);
        if (starts.indexOf(full) === -1) starts.push(full);
    });
    return starts;
}

function getUserScriptSearchPaths() {
    const result = [];
    getUserScriptStartDirs().forEach(start => {
        let dir = start;
        for (let level = 0; level <= USERSCRIPT_MAX_LEVELS_UP; level++) {
            if (level === 0) result.push(path.join(dir, 'userScript.js')); // copied right next to this file
            USERSCRIPT_SUBPATHS.forEach(sub => {
                const full = path.join(dir, sub);
                if (result.indexOf(full) === -1) result.push(full);
            });
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    });
    return result;
}

function findUserScriptPath() {
    const paths = getUserScriptSearchPaths();
    for (let i = 0; i < paths.length; i++) {
        try {
            if (fs.statSync(paths[i]).isFile()) return paths[i];
        } catch (e) { /* try next */ }
    }
    return null;
}

var userScriptCache = null;

// Returns the userScript.js source as a string (cached, re-read if the file changes).
function readUserScript() {
    const filePath = findUserScriptPath();
    if (!filePath) {
        throw new Error('userScript.js not found. Looked for ' + USERSCRIPT_SUBPATHS.join(', ') +
            ' (up to ' + USERSCRIPT_MAX_LEVELS_UP + ' levels up) starting from:\n' + getUserScriptStartDirs().join('\n'));
    }
    const mtime = fs.statSync(filePath).mtimeMs;
    if (!userScriptCache || userScriptCache.path !== filePath || userScriptCache.mtime !== mtime) {
        userScriptCache = { path: filePath, mtime: mtime, code: fs.readFileSync(filePath, 'utf8') };
    }
    return userScriptCache.code;
}

// A tiny script that shows why the local userScript.js could not be loaded.
// Served with HTTP 200 on purpose: browsers do not run a <script src> that came back with an error status.
function userScriptErrorSnippet(err) {
    const msg = 'TizenTube: failed to load local userScript.js\n' + (err && err.message ? err.message : String(err));
    return '(function(){var m=' + JSON.stringify(msg) + ';try{console.error(m);}catch(e){}try{if(typeof alert==="function")alert(m);}catch(e){}})();';
}

function connectToDebugger(host, port, args) {
    fetch(`http://${host}:${port}`).then(_ => {
        CDP({ host, port, local: true }, client => {
            isConnecting = false;
            client.Runtime.enable();
            client.Page.enable();

            // Must be set BEFORE navigating, so the new document is created without CSP.
            client.Page.setBypassCSP({ enabled: true });

            client.on('Runtime.executionContextCreated', m => {
                // Runtime.evaluate is not subject to the page's CSP, and the file is read
                // locally from the .wgt, so no network request is needed at all.
                let modFile;
                try {
                    modFile = readUserScript();
                } catch (e) {
                    client.Runtime.evaluate({ expression: userScriptErrorSnippet(e), contextId: m.context.id });
                    return;
                }
                client.Runtime.evaluate({ expression: modFile, contextId: m.context.id });
            });

            client.Page.navigate({ url: `https://youtube.com/tv?additionalDataUrl=http%3A%2F%2Flocalhost%3A8085%2Fdial%2Fapps%2FYouTube${args ? `&${args}` : ''}` });
        })
    }).catch(e => {
        return setTimeout(() => connectToDebugger(host, port, args), 100);
    })
}

function canConnectToDaemon() {
    return fetch('http://127.0.0.1:8001/api/v2/').then(res => res.json())
        .then(json => {
            return { canConnectToDaemon: (json.device.developerIP === '127.0.0.1' || json.device.developerIP === '1.0.0.127') && json.device.developerMode === '1', ip: json.device.ip, isConnecting }
        }).catch(e => {
            return canConnectToDaemon();
        });
}

function startDebugger(args) {
    return canConnectToDaemon().then(res => {
        if (!res.canConnectToDaemon) return false;
        const client = adbhost.createConnection({ host: '127.0.0.1', port: 26101 });

        client._stream.on('connect', () => {
            const packageId = tizen.application.getAppInfo().packageId;
            isConnecting = true;
            const shellCmd = client.createStream(`shell:0 debug ${packageId}.TizenTubeStandalone${isTizen3 ? ' 0' : ''}`);
            shellCmd.on('data', (data) => {
                const dataString = data.toString();
                if (dataString.includes('debug')) {
                    const port = Number(dataString.substr(dataString.indexOf(':') + 1, 6).replace(' ', ''));
                    connectToDebugger(res.ip, port, args);
                    setTimeout(() => client._stream.end(), 1000);
                }
            });
        });

        return true;
    });
}

module.exports = {
    startDebugger,
    canConnectToDaemon,
    readUserScript,
    userScriptErrorSnippet,
    getUserScriptSearchPaths
};