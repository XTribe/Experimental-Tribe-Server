This file describe the meaning of each file in the conf directory

README.md
  This file


config.json.template
  This is the template for the configuration file of ETS. It should
  be copied as "config.json" by the install script. Do not modify the 
  .template file. Make your customization in config.js

  
Ubuntu services/redis-server
  This is the standard init.d file for redis located in /etc/init.d/
  the solely change we made is adding the line
  initctl emit redis-server-started
  in the start) case if redis starts correctly.
  This message is used to let redis.conf start after redis is started (see
  redis.conf)


Ubuntu services/ets-server.conf
  This is the upstart file for the ets server. Copy it in /etc/init and
  customize it. Symlinking the file in /etc/init seems not to work.