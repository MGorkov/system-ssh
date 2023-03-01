const EventEmitter = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const util = require('util');
const Channel = require('./Channel');
const debuglog = util.debuglog('sshclient');

const SOCKET_BASEDIR = '/tmp/system-ssh';
const CHECK_MASTER_TIMEOUT = 1000 * (1 + (0.5 - Math.random()) * 0.2) | 0; // 900..1100 ms
let connects = new Map(); // host connections
const cReady = Symbol('connectReady');
const cSpawned = Symbol('connectSpawned');

/**
 * Returns existing or new ssh connect
 * @param config
 * @param socketFile
 * @returns {any}
 */
function getConnect(config, socketFile) {
    let objConnect = connects.get(config.host);
    if (objConnect) {
        debuglog('host="%s": ssh master already running pid=%d', config.host, objConnect.ssh.pid);
        objConnect.used++;
    } else {
        debuglog('host="%s": ssh master spawn', config.host);
        const now = Date.now();
        let args = [
            '-T',
            '-N',
            '-M',
            `-S${socketFile}`,
            `-i${config.identityFile}`,
            `-l${config.username}`,
            `-p${config.port}`,
        ];
        if (config.forceIPv4) {
            args.push('-4');
        } else if (config.forceIPv6) {
            args.push('-6');
        }
        if (config.localAddress) {
            args.push(`-b${config.localAddress}`);
        }
        if (config.options) {
            config.options.forEach((opt) => {
                args.push(`-o${opt}`);
            })
        }
        if (config.jumpHosts) {
            args.push(`-J${config.jumpHosts}`);
        }
        args.push(config.host);
        let connect = spawn('ssh', args);
        debuglog('host="%s": spawn blocked eventloop for %d ms', config.host, Date.now() - now)
        connect[cReady] = false;
        connect[cSpawned] = false;
        objConnect = {
            ssh: connect,
            used: 1
        }
        connects.set(config.host, objConnect);
    }
    return objConnect.ssh;
}

function createFolderIfNotExists(folderPath) {
    try {
        fs.mkdirSync(folderPath);
    } catch (err) {
        // it's okay if folder already exists
        if ( err.code !== 'EEXIST' ) throw err;
    }
}

class Client extends EventEmitter {
    constructor() {
        super();

        this.config = {
            host: undefined,
            port: undefined,
            localAddress: undefined,
            forceIPv4: undefined,
            forceIPv6: undefined,
            username: undefined,
            identityFile: undefined,
            options: undefined,
            jumpHosts: undefined,
        };

        this.checkMaster = this.checkMaster.bind(this);

        this.runningCmds = new Set();
        this.forwardings = new Set();

        createFolderIfNotExists(SOCKET_BASEDIR);

    }

    end() {
        if (this.ended) {
            debuglog('host="%s": ssh already ended', this.config.host);
            return;
        }
        debuglog('host="%s": ending ssh', this.config.host);
        this.ended = true;
        this.runningCmds.forEach((sshCmd) => {
            sshCmd.stdin?.end('\n');
            sshCmd.kill();
        })

        this.forwardings.forEach((fwdargs) => {
            this.unforward(fwdargs);
        })
        this.forwardings.clear();

        this.stopMaster();
        clearTimeout(this.checkTimeout);
    }

    stopMaster() {
        let objConnect = connects.get(this.config.host);
        if (objConnect?.used === 1) {
            setTimeout(() => {
                if (this.runningCmds.size) {
                    setTimeout(() => this.stopMaster(), 100);
                } else if (objConnect.used === 1) {
                    debuglog('host="%s": stopping master', this.config.host);
                    this.sshConnection.kill();
                    connects.delete(this.config.host);
                } else {
                    objConnect.used--;
                }
            }, 100)
        } else {
            objConnect.used--;
            this.removeListeners();
            this.emit('close');
        }
    }

    removeListeners() {
        this.sshConnection.removeListener('spawn', this.onSpawn);
        this.sshConnection.removeListener('close', this.onClose);
        this.sshConnection.removeListener('error', this.onError);
        this.sshConnection.stderr.removeListener('data', this.onStderr);
    }

    unforward(fwdargs) {
        let sshCmd = spawn('ssh', fwdargs, {stdio: ['ignore', 'ignore', 'pipe']});

        let stderr = '';
        sshCmd.stderr.on('data', (data) => {
            stderr += data;
        })

        sshCmd.on('close', (code, signal) => {
            debuglog('host="%s": unforward closed with code=%d signal=%s stderr="%s"', this.config.host, code, signal, stderr);
        })

        sshCmd.on('error', (err) => {
            debuglog('host="%s": unforward error "%s"', this.config.host, err);
        });

    }

    connect(cfg) {
        this.ended = false;
        this.config.host = cfg.hostname || cfg.host || 'localhost';
        this.config.port = cfg.port || 22;
        this.config.localAddress = cfg.localAddress;
        this.config.forceIPv4 = cfg.forceIPv4 || false;
        this.config.forceIPv6 = cfg.forceIPv6 || false;
        this.config.username = cfg.username || cfg.user || 'postgres';
        this.config.identityFile = cfg.identityFile;
        this.config.options = cfg.options;
        this.config.jumpHosts = cfg.jumpHosts;

        const socketDir = path.join(SOCKET_BASEDIR, this.config.host);
        this.socketFile = path.join(socketDir, `ssh.sock`);

        createFolderIfNotExists(socketDir);

        this.sshConnection = getConnect(this.config, this.socketFile);

        let stderr = '';
        this.onStderr = (data) => {
            stderr += data;
        };
        this.sshConnection.stderr.on('data', this.onStderr);

        this.onClose = (code, signal) => {
            debuglog('host="%s": ssh master closed with code=%d signal=%s', this.config.host, code, signal);
            if (code !== 0 && stderr) {
                this.emit('error', new Error(stderr))
            }
            this.removeListeners();
            this.emit('close', code, signal);
        }
        this.sshConnection.on('close', this.onClose);

        this.onError = (err) => {
            debuglog('host="%s": ssh master error "%s"', this.config.host, err);
            this.emit('error', err);
        }
        this.sshConnection.on('error', this.onError);

        this.onSpawn = () => {
            debuglog('host="%s": ssh master spawned pid=%d', this.config.host, this.sshConnection.pid);
            this.sshConnection[cSpawned] = true;
            this.checkMaster();
        };

        if (this.sshConnection[cReady] === true) {
            this.emit('ready');
        } else if (this.sshConnection[cSpawned]) {
            this.checkMaster();
        } else {
            this.sshConnection.on('spawn', this.onSpawn);
        }

    }

    checkMaster() {
        fs.access(this.socketFile, (err) => {
            if (err) {
                debuglog('host="%s": ssh master is not ready', this.config.host);
                this.checkTimeout = setTimeout(this.checkMaster, CHECK_MASTER_TIMEOUT);
            } else {
                debuglog('host="%s": socket file exists "%s"', this.config.host, this.socketFile);
                const sshSocket = new net.Socket();
                sshSocket.on('error', (err) => {
                    debuglog('host="%s": error connecting to socket file: %s', this.config.host, err);
                    if (err.code === 'ECONNREFUSED') {
                        debuglog('host="%s": socket file is not used, delete it', this.config.host);
                        try {
                            fs.unlinkSync(this.socketFile);
                        } catch (err) {
                            debuglog('host="%s": error delete socket file %s', this.config.host, err);
                        }
                    }
                    this.checkTimeout = setTimeout(this.checkMaster, CHECK_MASTER_TIMEOUT);
                });
                sshSocket.connect({path: this.socketFile}, () => {
                    debuglog('host="%s": ssh master is ready', this.config.host);
                    sshSocket.destroy();
                    this.sshConnection[cReady] = true;
                    this.emit('ready');
                });
            }
        })
    }

    exec(cmd, options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = {};
        }

        const now = Date.now();
        const sshCmd = spawn('ssh',
            [
                '-T',
                `-S${this.socketFile}`,
                this.config.host,
                cmd
            ],
            options
        );
        debuglog('host="%s": spawn blocked eventloop for %d ms', this.config.host, Date.now() - now)

        let stderr = '';
        sshCmd.stderr.on('data', (data) => {
            stderr += data;
        })

        const channel = new Channel(sshCmd);

        sshCmd.on('spawn', () => {
            debuglog('host="%s": command "%s" is running pid=%d', this.config.host, cmd, sshCmd.pid);
            this.runningCmds.add(sshCmd);
            return callback(null, channel);
        })

        sshCmd.on('close', (code, signal) => {
            debuglog('host="%s": command "%s" closed with code=%d signal=%s stderr=%s', this.config.host, cmd, code, signal, stderr);
            if (this.runningCmds.has(sshCmd)) {
                this.runningCmds.delete(sshCmd);
            } else if (code !== 0) {
                return callback(new Error(`command closed with code=${code} signal=${signal} stderr=${stderr}`));
            }
            channel.destroy(null, () => {
                channel.emit('exit', code, signal);
                channel.emit('close', code, signal);
            });
        })

        sshCmd.on('error', (err) => {
            debuglog('host="%s": command "%s" error "%s"', this.config.host, cmd, err);
            this.runningCmds.delete(sshCmd);
            return callback(err);
        });

    }

    forwardOut(srcIP, srcPort, dstIP, dstPort, callback) {
        srcIP = srcIP || 'localhost';

        let sshCmd = spawn('ssh',
            [
                `-S${this.socketFile}`,
                '-Oforward',
                `-L${srcIP ? `${srcIP}:` : ''}${srcPort}:${dstIP}:${dstPort}`,
                this.config.host,
            ],
            {stdio: ['ignore', 'ignore', 'pipe']}
        );

        let stderr = '';
        sshCmd.stderr.on('data', (data) => {
            stderr += data;
        })

        sshCmd.on('close', (code, signal) => {
            debuglog('host="%s": forwardout closed with code=%d signal=%s stderr="%s"', this.config.host, code, signal, stderr);
            if (code === 0) {
                debuglog('host="%s": forwardout is running pid=%d', this.config.host, sshCmd.pid);
                let socket = new net.Socket();
                socket.on('connect', () => {
                    debuglog('host="%s": forwardout socket connected', this.config.host);
                    this.forwardings.add(
                        [
                            `-S${this.socketFile}`,
                            '-Ocancel',
                            `-L${srcIP ? `${srcIP}:` : ''}${srcPort}:${dstIP}:${dstPort}`,
                            this.config.host,
                        ],
                    )
                    return callback(null, socket);
                })
                socket.on('error', (err) => {
                    debuglog('host="%s": forwardout socket error "%s"', this.config.host, err);
                    return callback(err);
                })
                socket.connect(srcPort, srcIP);
            } else if (stderr) {
                return callback(new Error(stderr));
            } else {
                return callback(new Error(`Error code ${code}`));
            }
        })

        sshCmd.on('error', (err) => {
            debuglog('host="%s": forwardout error "%s"', this.config.host, err);
            return callback(err);
        });

    }

    forwardOutLocalSocket(localSocket, dstIP, dstPort, callback) {
        let sshCmd = spawn('ssh',
            [
                `-S${this.socketFile}`,
                '-Oforward',
                `-L${localSocket}:${dstIP}:${dstPort}`,
                this.config.host,
            ],
            {stdio: ['ignore', 'ignore', 'pipe']}
        );

        let stderr = '';
        sshCmd.stderr.on('data', (data) => {
            stderr += data;
        })

        sshCmd.on('close', (code, signal) => {
            debuglog('host="%s": forwardout socket closed with code=%d signal=%s stderr="%s"', this.config.host, code, signal, stderr);
            if (code === 0) {
                debuglog('host="%s": forwardout socket is running pid=%d', this.config.host, sshCmd.pid);
                this.forwardings.add(
                    [
                        `-S${this.socketFile}`,
                        '-Ocancel',
                        `-L${localSocket}:${dstIP}:${dstPort}`,
                        this.config.host,
                    ],
                )
                return callback(null);
            } else if (stderr) {
                return callback(new Error(stderr));
            } else {
                return callback(new Error(`Error code ${code}`));
            }
        })

        sshCmd.on('error', (err) => {
            debuglog('host="%s": forwardout socket error "%s"', this.config.host, err);
            return callback(err);
        });

    }

}

module.exports = Client;