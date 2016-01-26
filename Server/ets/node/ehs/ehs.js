/*

  EHS - Expriments Handling Server
  
  Represent the system that manage creation and user's join during experiments.
  
*/

function MemoryTracer() {
  this.previous = null;
}

MemoryTracer.prototype.dump = function() {
  var current = process.memoryUsage();
  console.log('MEMDUMP: ' + 'Res: ' + this.fmt(current.rss) + " hUse: " + this.fmt(current.heapUsed));
  if (this.previous) {
//    console.log('MEMDUMP: ' + 'Res: ' + this.fmt(current.rss - this.previous.rss) + " hUse: " + this.fmt(current.heapUsed - this.previous.heapUsed));
  }
  this.previous = process.memoryUsage();
}

MemoryTracer.prototype.fmt = function(v) {
  return Math.ceil(v/1000) + "KB";
}

var Pubsub  = require('pubsub')
  , Logger  = require('logger')
  , Manager = require('manager')
  , User    = require('user')
  , Stash   = require('stash')
  , Url     = require('url')
  , Tools   = require('tools')
  , Step    = require('step')
  , Experiments = require('experiment')
  , Http    = require('http')
  , Sockjs  = require('sockjs')
  , Client  = require('client').Client
  , util = require('util');

var cfg = require('config').read()

var startedAt = Date.now();

var stats = {
  service: 'EHS',
  uptime:           { label: 'Uptime (seconds)', value: Math.ceil((Date.now() - startedAt) / 1000) },
  connectedClients: { label: 'Connected clients', value: 0 },
  receivedMessages: { label: 'Received messages', value: 0 },
  instances:        { label: 'Instances in pool', value: 0 },
  createdInstances: { label: 'Instances created', value: 0 }
};

var Instance = require('instance');

global.INSTANCE_MODELS = {};

var pub
  , log
  , stash
  , server
  , sockjs;

function main() {

  var site;
  pub = Pubsub.createClient(cfg.services.stash.backend == 'file');
  log = Logger.createClient('EHS');
  stash = Stash.createClient();

  log.info("Starting EHS (" + Tools.endpointGetPort(cfg.services.ehs.endpoint) + ")");

  Instance.reset();

  var site = Url.parse(cfg.services.site.endpoint);
  if (!site.protocol) {
    site = Url.parse("http://" + cfg.services.site.endpoint);
  }

  /* Close instances that remained open, after ehs went offline the last time. This means, if mhs/ehs died for some error,
  ongoing games instances at that time, remained hunged, will be closed. */
  Instance.closeHungedInstances(pub,site);

  /* Statistics publisher */
  if (cfg.services.stats.enabled > 0) {
    setInterval(function() {
      // FIXME    stats.instances.value = Exp.sumInstances();
      stats.instances.value = 0;
      stats.uptime.value = Math.ceil((Date.now() - startedAt) / 1000);
      pub.publish(Pubsub.channels.STATS, stats);
    }, cfg.services.stats.interval * 1000);
  }

  sockjs = Sockjs.createServer(); 
  server = Http.createServer();
  sockjs.installHandlers(server, {
    prefix:'/ehs', 
    sockjs_url: "http://cdn.sockjs.org/sockjs-0.3.min.js"
  });
  server.listen(Tools.endpointGetPort(cfg.services.ehs.endpoint), '0.0.0.0');

  sockjs.on('connection', function(socket) {

    var client = new Client(socket);

    stats.connectedClients.value++;

    socket.on('data', function(data) {

      var message;

      try {
        message = JSON.parse(data);
      } catch(e) {
        log.warn("Unexpected input from client (invalid JSON)");
        socket.close();
        return;
      }

      stats.receivedMessages.value++;
 
      if (!Tools.isDef(message.params)) {
        client.send({topic: 'refuse', params: {reason: "Message format error"}});
        return;
      }

      var eId = message.params.eId
        , uId = message.params.uId
        , guid = message.params.guid
        , account

      // uId is 0 for anonymous users
      if (!Tools.isDef(eId) || !Tools.isDef(uId) || !Tools.isDef(guid)) {
        client.send({topic: 'refuse', params: {reason: "Message format error"}});
        return;
      }
        
      Step(

        function() {
          User.getUser(site, uId, guid, this);
        },

        function(err, user) {

          if (err) {
            throw err;
          }

          // Can be null for anonymous users
          account = user;

          Experiments.get(site, eId, this);
        },

        function(err, experiment) {
            /*pub.publish(Pubsub.channels.INSTANCE_ERROR, {
              eId: experiment.data.eId, 
              iId: Object.keys(global.INSTANCE_MODELS),
              site: ""
            });*/

          if (err) {
            client.send({topic: 'refuse', params: {reason: err}});
            log.error("Error contacting Drupal for experiment data: " + err);
            return;
          }

          if (account.uId == 0 && "0" == experiment.data.anonymousJoin) {
            client.send({topic: 'refuse', params: {reason: "Anonymous users can't join experiment"}});
            log.warning("Anonymous users can't join");
            return;
          }
          
          if ("0" == experiment.data.canPerform) {
            client.send({topic: 'refuse', params: {reason: "The experiment is not active at the moment"}});
            log.warning("Attempt to join an inactive experiment");
            return;
          }

          /* Store some data in the client needed at the moment of disconnection.
	  Disconnection happens when user change page (on his own accord or for we
	  made him go to the game page)
           */
          client.set('_user_data_', {guid: guid, uId: uId, site: site});
          
          log.verbose(message.topic + " request from " + eId + "/" + uId + " guid: " + guid);

          if ('join' == message.topic) {
            processJoin(client, experiment, account, site);
          } else {
            /* FIXME from a semantic point of view this is the case in which there is no join so the 'refuse' is not really appropriate */
            client.send({topic: 'refuse', params: {reason: "I do not understand " + message.topic}});
            log.warning("Attempt to join an inactive experiment");
          }
        }
      );
    });

    socket.on('close', function() {

      log.info("Client disconnected");

      var iId = client.get('_instance_id_');

      if (!iId) {
        return;
      }

      var instance = global.INSTANCE_MODELS[iId];
        
      if (!instance) {
        log.warn("Empty instance on disconnect");
        return;
      }

      var userData = client.get('_user_data_');

      if (!userData) {
        log.warn("Problem retrieving data on disconnect");
        return;
      }

      Instance.removeUserFromInstance(instance.data, userData.guid, function(err, users) {

        instance.data.users = users;

        if (!instance.data.complete) {
          log.verbose("User leave " + userData.guid)
          pub.publish(Pubsub.channels.INSTANCE_LEAVE, {eId: instance.data.eId, uId: userData.uId, guid: userData.guid, site: userData.site});
          instance.notifyManager('leave', userData.guid);
          instance.notifyUsers('status');

          if (0 == users.length) {
            pub.publish(Pubsub.channels.INSTANCE_DROP, {
		          eId: instance.data.eId, 
		          iId: instance.data.id,
		          uId: userData.uId, 
		          guid: userData.guid,
		          site: userData.site});
            instance.notifyManager('drop');
          }
              
        } else {
          log.verbose("User part " + userData.guid)
        }
            
        if (users.length == 0) {
          delete global.INSTANCE_MODELS[instance.data.id]; 
        }
            
      });
    });
  });
}

function processJoin(client, experiment, account, site) {

  var mGw = new ManagerGateway(experiment.eId);

  Step(

    function(err) {
      // Find an instance to insert the user into
      Instance.addUserToInstance(experiment.eId, account, experiment.data.exactNUsers, experiment.data.share_languages,this);      
    }
    
    ,
    
    function(err, instanceData) {

      if (err || !instanceData) {
        client.send({topic: 'refuse', params: {reason: err}});
        log.error("Error joining the instance: " + err);

        return;
      }

      var instance;
      
      //log.verbose("global.INSTANCE_MODELS[instanceData.id]: " + global.INSTANCE_MODELS[instanceData.id])
      if ('undefined' == typeof global.INSTANCE_MODELS[instanceData.id]) {
        log.verbose("New instance created " + instanceData.id)
        instance = new InstanceModel(instanceData, mGw);
	
      	pub.publish(Pubsub.channels.INSTANCE_NEW, {
      		eId: instance.data.eId, 
      		iId: instanceData.id, 
      		uId: account.uId, 
      		guid: account.guid,
      		site: site});
          
        global.INSTANCE_MODELS[instanceData.id] = instance
      } else {
        // Refresh data of the instance
        global.INSTANCE_MODELS[instanceData.id].setData(instanceData)
        instance = global.INSTANCE_MODELS[instanceData.id]
      }

      client.set('_instance_id_', instanceData.id);

      instance.addClient(client);

      // Tell the manager that an user joined. Note that this is a "best effort"
      // action, because the manager could not be ready/started at the moment
      // This error is delegated to the "ping" message (on instance complete)
      instance.notifyManager('join', account.guid);
    
      instance.notifyUsers('status');

      pub.publish(Pubsub.channels.INSTANCE_JOIN, {
        eId: experiment.eId, 
        uId: account.uId, 
        guid: account.guid, 
        site: site});

      client.send({topic: 'accept'});
  
      if (instanceData.complete) {

        pub.publish(Pubsub.channels.INSTANCE_STARTED, {
          eId: experiment.eId, 
          iId: instanceData.id, 
          uId: instanceData.users.map(function(u) { return u.uId }),
          guid: instanceData.users.map(function(u) { return u.guid }),
          site: site});

        // Let's ping the manager
        mGw.ping(experiment.eId, function(err) {
          
          if (err) {
            instance.notifyUsers('error', err);
            client.socket.close();
            return;
          }
          
          // "Pass" the instance data over to MHS, saving it to Redis
          // (Note that only completed instances are saved to Redis)
          Instance.save(instanceData, function() {
            instance.notifyUsers('start');  
            client.socket.close();
            instance = undefined;
          });
        });  
        }
    }
  );
}

function ManagerGateway(eId) {
  this.client = null;
  this.endPoint = null;
  this.experiment = Experiments.retrieve(eId, true);
}

ManagerGateway.prototype.acquireClient = function() {

  if (this.client) {
    return;
  }
  
  // This should really never be the case
  if ('undefined' == typeof this.experiment.data.managerURI) {
    return;
  }
  
  var parts = Url.parse(this.experiment.data.managerURI);

  this.endPoint = parts.pathname;

  // FIXME: HTTPS and authentication test
  this.client = Manager.createClient((parts.auth ? (parts.auth + "@") : '' ) + parts.hostname, parts.port);
  
  return true;  
}
  
ManagerGateway.prototype.ping = function(eId, cb) {

  var self = this;
  
  this.acquireClient();

  if (!this.client) {
    cb & cb("Manager is not defined");
    return;
  }

  var msgOut = this.prepareSystemMessage('ping')

  this.forward(msgOut, function(error, response) {

    if (error) {
      cb & cb("Cannot connect to the experiment manager (" + self.experiment.data.managerURI + ") " + error);
   
        var site = Url.parse(cfg.services.site.endpoint);
        if (!site.protocol) {
          site = Url.parse("http://" + cfg.services.site.endpoint);
        }

        // Object.keys(global.INSTANCE_MODELS) retrieve the instance id
        // If the manager is not responding the instance get closed
        pub.publish(Pubsub.channels.INSTANCE_DROP, {
              eId: self.experiment.data.eId, 
              iId: Object.keys(global.INSTANCE_MODELS), 
              /*uId: account.uId, 
              guid: account.guid,*/
              site: site
        });

      return;
    }
    
    log.verbose("Manager contacted at " + self.experiment.data.managerURI);
    
    cb && cb();
  });
}
  
ManagerGateway.prototype.forward = function(msgOut, cb) {
  
  this.acquireClient();

  if (!this.client) {
    cb & cb("Manager is not defined");
    return;
  }
  
  this.client.post(this.endPoint, msgOut, cb);
}

ManagerGateway.prototype.prepareSystemMessage = function(topic) {
  return {
    sender: 'system',
    topic: topic
  }
}

function InstanceModel(instanceData, manGw) {
  this.data           = instanceData
  this.managerGateway = null;
  this.clients        = [];
  this.managerGateway = manGw;
  this.notifyManager('instance');
  this.listenToManager();
}

InstanceModel.prototype.setData = function(data) {
  this.data = data;
}

InstanceModel.prototype.addClient = function(client) {
  this.clients.push(client);
}

InstanceModel.prototype.notifyUsers = function(topic, params) {
  
  var users      = this.data.users
    , experiment = Experiments.retrieve(this.data.eId, true)
    , client
    , userData
    , _params

  // _params will be augmented later with "guid"
  switch (topic) {
    
    case 'error':
      _params = {iId: this.data.id, error: params};
      break;
    
    case 'status':
      _params = {iId: this.data.id, nUsers: this.data.users.length, nUsersMin: experiment.data.exactNUsers};
      break;
    
    case 'start':
      _params = {iId: this.data.id, eId: this.data.eId};
      break;
      
    default:
      return;
    
  }
  
  for (var i = 0; i < this.clients.length; i++) {
    client = this.clients[i]
    // TODO: verificare che il client sia attivo
    userData = client.get('_user_data_');
    if (!userData) {
      error("Client has not user data (status)")
    } else {
      _params.guid = userData.guid;
      client.send({topic: topic, params: _params});
    }
  }
}

InstanceModel.prototype.listenToManager = function(cb) {
  if (!this.managerGateway) {
    return;
  }
  /* FIXME it must be implemented via HTTP
  var instance = this;
  this.managerGateway.conn.on('data', function(data) {
    var message = JSON.parse(data);
    log.write("Message received from manager");
    console.log(message);
    if (message.topic == 'start'){
      instance.notifyUsers('start');
    }
  });
  */
  
}
  
InstanceModel.prototype.notifyManager = function(topic, data) {
    
  if (!this.managerGateway) {
    return;
  }

  var experiment = Experiments.retrieve(this.data.eId, true)

  var msgOut = this.managerGateway.prepareSystemMessage(topic);

  msgOut.instanceId = this.data.id
  msgOut.experiment = {
      id: this.data.eId,
      town: experiment.data.town
  };
  msgOut.params = {}
  
  switch (topic) {
    case 'instance':
      break;
      
    case 'join':
    case 'leave':
      msgOut.clientId = data
      break;
      
    case 'drop':
      break;
      
    // FIXME error management
    default:
      throw "Undefined system message"
      return;
  }
  
  this.managerGateway.forward(msgOut, function(error, response) {
    // FIXME error management
  });

}

if (require.main === module) {
  main()
  Tools.changeProcessOwnership(cfg)
} else {
  exports.main = main;
}

