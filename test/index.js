const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { execSync, spawn } = require('child_process');

const MSG_STDOUT = 'stdout test\n';
const MSG_STDERR = 'stderr test\n';
const SSH_CONFIG_DIR = path.join(process.cwd(), 'test/ssh_config');
const SSH_PORT = 2222;
const SSH_USERNAME = process.env.USERNAME || execSync('id -un').toString().trim();

const { Client } = require('../');
const sshConnection = new Client();
const KEYS = ['rsa', 'ed25519'];

describe('ssh client', function () {
    let sshd;
    this.timeout(5000);
    this.slow(3000);

    it('create ssh keys and config', function () {
        if (!fs.existsSync(SSH_CONFIG_DIR)) {
            fs.mkdirSync(SSH_CONFIG_DIR);
            const sshdConfig = [
                `Port ${SSH_PORT}`,
                `PidFile ${SSH_CONFIG_DIR}/sshd.pid`,
                `AuthorizedKeysFile ${SSH_CONFIG_DIR}/authorized_keys`,
                `AllowUsers ${SSH_USERNAME}`,
                `PasswordAuthentication no`,
                `PermitRootLogin no`,
            ];
            KEYS.forEach((type) => {
                execSync(`ssh-keygen -q -f ${SSH_CONFIG_DIR}/ssh_host_${type}_key -N '' -t ${type}`)
                sshdConfig.push(`HostKey ${SSH_CONFIG_DIR}/ssh_host_${type}_key`);
            });
            KEYS.forEach((type) => {
                execSync(`ssh-keygen -q -f ${SSH_CONFIG_DIR}/id_${type} -N '' -t ${type}`);
                execSync(`cat ${SSH_CONFIG_DIR}/id_${type}.pub >> ${SSH_CONFIG_DIR}/authorized_keys`);
            });

            fs.writeFileSync(`${SSH_CONFIG_DIR}/sshd_config`, sshdConfig.join('\n'));
            execSync(`ssh-keygen -R [localhost]:${SSH_PORT}`);
        }
    })

    it('starting sshd', function (done) {
        sshd = spawn('/usr/sbin/sshd', ['-D', `-f${SSH_CONFIG_DIR}/sshd_config`], );
        let stderr = '';
        sshd.stderr.on('data', (data) => {
            stderr += data;
        })
        sshd.once('error', done);
        sshd.once('close', (code, signal) => {
            if (code !== 0) {
                return done(`Error spawn sshd code=${code} signal=${signal} stderr=${stderr}`);
            }
        })
        sshd.on('spawn', done);
    })

    KEYS.forEach((keyType) => {
        it(`connect ${keyType}`, function (done) {
            let sshConfig = {
                hostname: 'localhost',
                port: SSH_PORT,
                username: SSH_USERNAME,
                identityFile: path.join(SSH_CONFIG_DIR, `id_${keyType}`),
                options: ['StrictHostKeyChecking=no', 'IdentitiesOnly=yes'],
            }

            sshConnection.once('error', done);
            sshConnection.once('ready', () => {
                sshConnection.removeListener('error', done);
                done();
            });
            sshConnection.connect(sshConfig);
        });

        it('exec stdout', function (done) {
            const CMD = `echo ${MSG_STDOUT}`;

            sshConnection.exec(CMD, (err, stream) => {
                if (err) {
                    return done(err);
                }
                let data = '';
                stream.on('data', (chunk) => {
                    data += chunk;
                });
                stream.on('close', () => {
                    try {
                        assert.equal(data, MSG_STDOUT);
                        done();
                    } catch (err) {
                        done(err);
                    }
                })
                stream.on('error', done);
            });

        })
        it('exec stderr', function (done) {
            const CMD = `echo >&2 ${MSG_STDERR}`;

            sshConnection.exec(CMD, (err, stream) => {
                if (err) {
                    return done(err);
                }
                let stderr_data = '';
                stream.stderr.on('data', (chunk) => {
                    stderr_data += chunk;
                });
                stream.stderr.on('close', () => {
                    try {
                        assert.equal(stderr_data, MSG_STDERR);
                        done();
                    } catch (err) {
                        done(err);
                    }
                })
                stream.stderr.on('error', done);

            });

        })

        it(`end ${keyType}`, function (done) {
            sshConnection.once('error', done);
            sshConnection.once('close', () => {
                sshConnection.removeListener('error', done);
                done();
            });
            sshConnection.end();
        })
    })

    it('stop sshd', function (done) {
        sshd.once('close', done);
        sshd.kill();
    })

})