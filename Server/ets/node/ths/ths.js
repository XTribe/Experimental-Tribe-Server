/*  

  THS - Transaciont Handling Server
  
  Represent the system that updates statistics about transaction
  of game creation and ending

  Instance possible events:
  - Started: The number of users needed is reached so the instance is started (In this case, 'User' contains Drupal User id and guid of each user that joined the instance)
  - Performed: The manager sent a 'ready' message
  - Ended: The manager sent an 'over' message, which means the instance is ended in the correct way.<br>
  - Dropped (eventually): The users all leaved before beginning the instance or something prevented the game to begin (the manager is not responding, for example).<br>
  - Error (eventually): An error occurred. For example, a user leaved during the game. (At the moment, this is considered closing the instance.)<br>
  - Hunged: A system error occured and the instances has been forcedly closed as the Xtribe restarted.
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

  sub.subscribe(Pubsub.channels.INSTANCE_STARTED, function(message) {
    updateStatsFor('experiment', 'inst_started', message);
  })
  
  sub.subscribe(Pubsub.channels.INSTANCE_ERROR, function(message) {
    updateStatsFor('experiment', 'inst_error', message);
  })

  sub.subscribe(Pubsub.channels.INSTANCE_HUNGED, function(message) {
    updateStatsFor('experiment', 'inst_hunged', message);
  })

  function updateStatsFor(subject, stat, data) {
    
    if (stat=='inst_hunged') {
      var url = '/ets/services/close-hunged-instances';
    }else{
      var url = '/ets/services/' + ('experiment' == subject ? 'exp-stats' : 'user-stats');
    }

    //log.verbose("EVENT: "+stat+" sent to "+url+" with data "+JSON.stringify(data));
    
    data.stat = stat;
    data.timestamp = 0|(Date.now() / 1000);
    Drupal.setSite(data.site);
    Drupal.post(url, data, function(error, data) {
      if (error || parseInt(data) < 0) {
        log.error("Error trying to update " + stat + " subject: " + subject + " statistic: " + (error ? error : data));
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

