const { Duplex } = require('stream');
const util = require('util');
const debuglog = util.debuglog('sshchannel');

class Channel extends Duplex {
    constructor(sshCmd, options) {
        options = options || {};
        options.emitClose = false;
        super(options);
        this.stdout = sshCmd.stdout;
        this.stdin = sshCmd.stdin;
        this.stderr = sshCmd.stderr;

        debuglog('create channel for command "%s"', sshCmd.spawnfile);
        this.setupEvents();

    }

    _read(n) {
    }

    _write(data, enc, cb) {
        this.stdin?.write(data, enc, cb);
    }

    _final(cb) {
        this.stdin?.end(cb);
    }

    setupEvents() {
        this.stdout?.on('data', (data) => {
            this.push(data);
        });

    }

}

module.exports = Channel;
