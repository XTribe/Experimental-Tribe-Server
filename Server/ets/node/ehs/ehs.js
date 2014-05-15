/*

  EHS - Expriments Handling Server
  
  Rappresenta il sistema che gestisce la creazione e il join degli utenti
  negli esperimenti.
  
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
  , Client  = require('client').Client;

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

          /* Registriamo alcuni dati nel client che servono al 
           * momento della disconnessione. La disconnessione avviene
           * quando l'utente cambia pagina (per scelta sua o perché lo 
           * facciamo andare alla pagina del gioco)
           */
          client.set('_user_data_', {guid: guid, uId: uId, site: site});
          
          log.verbose(message.topic + " request from " + eId + "/" + uId + " guid: " + guid);

          if ('join' == message.topic) {
            processJoin(client, experiment, account, site);
          } else {
            /* FIXME da un punto di vista semantico qui il caso è che non ha un 'join', per cui il refuse non sarebbe adatto */
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
            pub.publish(Pubsub.channels.INSTANCE_DROP, {eId: instance.data.eId, site: userData.site});
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
      Instance.addUserToInstance(experiment.eId, account, experiment.data.exactNUsers, this);
    }
    
    ,
    
    function(err, instanceData) {

      if (err || !instanceData) {
        client.send({topic: 'refuse', params: {reason: err}});
        log.error("Error joining the instance: " + err);
        return;
      }

      var instance;
      
      if ('undefined' == typeof global.INSTANCE_MODELS[instanceData.id]) {
        log.verbose("New instance created " + instanceData.id)
        instance = new InstanceModel(instanceData, mGw);
        pub.publish(Pubsub.channels.INSTANCE_NEW, {eId: instance.data.eId, site: site});
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

      pub.publish(Pubsub.channels.INSTANCE_JOIN, {eId: experiment.eId, uId: account.uId, guid: account.guid, site: site});

      client.send({topic: 'accept'});
  
      if (instanceData.complete) {

        log.verbose("Instance " + instance.data.id + " is complete")

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

  // FIXME: HTTPS e test di autenticazione
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
      console.log(self.experiment.data.managerURI);
      cb & cb("Cannot connect to the experiment manager (" + self.experiment.data.managerURI + ") " + error);
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
      log.error("Client has not user data (status)")
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
  /* FIXME occorre implementarlo tramite HTTP
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

