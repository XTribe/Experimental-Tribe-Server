var Fs = require('fs'),
    Path = require('path'),
    Stash = require('stash')

var cfg = require('config').read()

var s = Stash.createClient()

s.set('_install_test_', Date.now(), function(err) {
  s.get('_install_test_', function(err,data) {
    s.del('_install_test_', function() {
      s.end()
    })
  })
})

