/*  

  THS - Transaciont Handling Server
  
  Rappresenta il sistema che aggiorna le statistiche riguardo le transazioni
  di creazione gioco e fine gioco

*/

var Logger = require('logger')
  , Pubsub = require('pubsub')
  , Tools  = require('tools')
  , Drupal = require('drupal').createClient()
  , sub
  , log

var cfg = require('config').read()

log = Logger.createClient('THS');

if (!cfg.services.redis.enabled) {
  log.warn("Redis is not enabled. THS will not be started");
  process.exit(0);
}

function main() {
  
  sub = Pubsub.createClient();
  
  log.info("Starting THS");

  sub.subscribe(Pubsub.channels.INSTANCE_NEW, function(message) {
    updateStatsFor('experiment', 'inst_created', message);
  })
  
  sub.subscribe(Pubsub.channels.INSTANCE_READY, function(message) {
    // @PERF we could delegate the user stats update to the experiment callback
    updateStatsFor('experiment', 'inst_performed', message);
    updateStatsFor('user', 'inst_started', message);
  })
  
  sub.subscribe(Pubsub.channels.INSTANCE_OVER, function(message) {
    // @PERF we could delegate the user stats update to the experiment callback
    updateStatsFor('experiment', 'inst_ended', message);
    updateStatsFor('user', 'inst_ended', message);
  })
  
  sub.subscribe(Pubsub.channels.INSTANCE_DROP, function(message) {
    updateStatsFor('experiment', 'inst_dropped', message);
  })
  
  function updateStatsFor(subject, stat, data) {
    var url = '/ets/services/' + ('experiment' == subject ? 'exp-stats' : 'user-stats')
    data.stat = stat;
    data.timestamp = 0|(Date.now() / 1000);
    Drupal.setSite(data.site);
    Drupal.post(url, data, function(error, data) {
      if (error || parseInt(data) < 0) {
        log.error("Error trying to update " + stat + " " + subject + " statistic: " + (error ? error : data));
        return;
      } 
    });
  }
  
}

if (require.main === module) {
  main();
  Tools.changeProcessOwnership(cfg);
} else {
  exports.main = main;
}

