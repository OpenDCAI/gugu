const { execFile } = require('node:child_process')

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} ${args.join(' ')} failed: ${stderr || stdout || error.message}`))
        return
      }
      resolve()
    })
  })
}

module.exports = async function sign(options) {
  if (process.platform !== 'darwin') return
  await run('/usr/bin/codesign', [
    '--force',
    '--deep',
    '--sign',
    '-',
    options.app,
  ])
}
