## Prerequisites

* Linux 
* Node.js (npm included)
* Redis
* Drupal 7.22

## Overview

The project contains two folder
* “Server”, containing the core data of the Experimental Tribe Server (ETS)
* “Drupal” contains the extensions needed by Drupal to work with it

The Drupal part include two modules and a theme, that can be installed in the usual Drupal way:
* ETS: core module
* Experiment content type: add the “Experiment” content type, needed to configure your experiments
* etslook, etslook_fb: Themes created for the project, that you can optionally use

The Server part include the core data of ETS. 
* “Bin” folder contains a shell script that must be installed via terminal, using “install” option and must be started using “start” option. 
* “Node” folder contains the core data code.
* “Conf” contains configuration files of the several components working with ETS.

## Configuration

Server/bin/server.sh
	Install after you installed Node.js, using “install” option via terminal.
Server/conf/config.json.template
This is the template for the configuration file of ETS. It should be copied as "config.json" by the install script. Do not modify the .template file. Follow comments in file "config.json"  to configure parameters, depending by your server characteristic.
Server/conf/Ubuntu upstart/
This folder contains template for Redis and ETS processes configuration, that must be configured, depending by your server characteristic. If you start processes during boot, please make sure Redis starts before ETS server. 

## Tutorial

Please refer to http://man.xtribe.eu/
