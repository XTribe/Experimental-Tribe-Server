
var Fs = require('fs')
  , cfg = require('config').read()
  , args = process.argv;

start();

function start() {

  var spawn = require("child_process").spawn
    // Children pids
    , pids = []
  
  var child
    , booting = true;

  [ 'ehs', 'mhs', 'ths' ].forEach(function(name) {

    if (cfg.services[name].enabled) {

      child = spawn( "node", [name] )
      pids.push(child.pid)
      
      child.stdout.pipe(process.stdout);
      child.stderr.pipe(process.stderr);

      child.on('exit', function(code) {
        if (code !== 0) {
          if (booting) {
            cleanup();
          }
          process.exit(code);
        }          
      })
    }
    
  });

  process.on('exit', function() {
    cleanup();
  })
  
  process.on('SIGINT', function() {
    console.log("SIGINT: shutting down...");
  });
  
  process.on('SIGTERM', function() {
    console.log("SIGTERM: shutting down...");
    process.exit(0);
  });
  
  function cleanup() {

    try {    
      Fs.unlinkSync(lockfile);
    } catch(e) {}
    
    // Kill children
    pids.forEach(function(pid) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch(e) {}
    })
    
    pids = []
  }
  
}
