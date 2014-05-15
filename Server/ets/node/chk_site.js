
var cfg = require('config').read()
  , Drupal = require('drupal');

var dc = new Drupal.createClient(cfg);

dc.get('/ets/services/ping', null, function(error, data) {
  if (error) {
    process.exit(1)
  }
  process.exit(0)
})
