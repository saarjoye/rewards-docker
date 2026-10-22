import { Client } from 'ssh2';

export function runRemote(cmd) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => {
      conn.exec(cmd, (err, stream) => {
        if (err) {
          conn.end();
          return reject(err);
        }
        let stdout = '';
        let stderr = '';
        stream.on('close', (code, signal) => {
          conn.end();
          resolve({ code, stdout, stderr });
        });
        stream.on('data', (data) => {
          stdout += data.toString();
        });
        stream.stderr.on('data', (data) => {
          stderr += data.toString();
        });
      });
    }).on('error', (err) => {
      reject(err);
    }).connect({
      host: '192.168.18.225',
      port: 22,
      username: 'root',
      password: 'Y858362599j',
      readyTimeout: 10000
    });
  });
}

// CLI usage
const cmd = process.argv.slice(2).join(' ');
if (cmd) {
  runRemote(cmd)
    .then((res) => {
      if (res.stdout) console.log(res.stdout);
      if (res.stderr) console.error(res.stderr);
      process.exit(res.code || 0);
    })
    .catch((err) => {
      console.error('SSH Error:', err.message);
      process.exit(1);
    });
}
