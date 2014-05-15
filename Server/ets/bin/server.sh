#!/bin/bash

# This can be overridden via config.json
_LOGFILE="/var/log/ets/ets.log"

C_OK="\E[1;42m OK \033[0m"
C_KO="\E[1;41m KO \033[0m"

function usage() {
  echo "Usage: $(basename $0) [install|update|start|stop|restart|status|test|log]"
  exit 1
}

function check_logdir() {
  [ ! -w $(dirname ${LOGFILE}) ] && { return 1; } || { return 0; }
}

function check_config() {
  node chk_config 2> /dev/null
  return $?
}

function check_stash() {
  node chk_stash 2> /dev/null
  return $?
}

function check_node() {
  return 0
}

function stop() {

  if [ ! -f /tmp/ets.pid ]; then
    echo "Server is already stopped (no pid file)."
  else
    echo "Stopping server..."
    kill $(cat /tmp/ets.pid)
    rm -f /tmp/ets.pid
  fi

}

function start() {
  
  echo "Starting..."

  check_node

  if [ $? != 0 ]; then
    echo "You're running a wrong version of node, you're using $NODE_VERSION, we need at least v0.6.0" >&2
    exit 1
  fi

  check_stash

  if [ $? != 0 ]; then
    echo "There is a problem accessing the stash server (file or redis). An error in config.json, maybe? Redis server not started?"
    exit 1
  fi

  check_logdir

  if [ $? != 0 ]; then
    echo "$(dirname ${LOGFILE}) is not writable"
    exit 1
  fi

  check_config

  if [ $? != 0 ]; then
    echo "Syntax error on config.json. Cannot continue."
    exit 1
  fi

  node server >> ${LOGFILE} 2>&1 &
  # This script is aimed to be used in a development environment, so use a "easy" dir
  echo $! > /tmp/ets.pid

}

cd `dirname $0`

if [ -d "../bin" ]; then
  cd "../"
fi

if [ "${1}" != "update" ] && [ "${1}" != "test" ] && [ "${1}" != "restart" ] && [ "${1}" != "log" ] && [ "${1}" != "status" ] && [ "${1}" != "start" ] && [ "${1}" != "stop" ] && [ "${1}" != "install" ]; then
  usage
fi

#if [ "$(id -u)" -eq 0 ]; then
#  echo "You shouldn't use this tool as root!"
#  exit 1
#fi

# Is node installed?
hash node > /dev/null 2>&1 || {
  echo "Please install node.js ( http://nodejs.org )" >&2
  exit 1
}

if [ "${1}" != "install" ]; then
 # LOGFILE=$(cat conf/config.json | grep -Po '"append_to"\s*:.*' | sed -n  's/.*:\s*"\(.*\)".*/\1/p')
 # [ "${LOGFILE}" = "" ] && LOGFILE=${_LOGFILE}
 LOGFILE=./ets.log
fi

# Is npm installed?
hash npm > /dev/null 2>&1 || {
  echo "Please install npm ( http://npmjs.org )" >&2
  exit 1
}

# Check npm version
#NPM_VERSION=$(npm --version)
#if [ ! $(echo $NPM_VERSION | cut -d "." -f 1-2) = "1.0" ]; then
#  echo "You're running a wrong version of npm, you're using $NPM_VERSION, we need 1.0.x" >&2
#  exit 1
#fi

# Check if the system is correctly installed
if [ "${1}" != "install" ] && [ ! -f .install ]; then
  echo The system is not correctly installed
  echo Please run $(basename $0) install
  exit 1
fi

if [ "${1}" != "install" ] && [ ! -f "conf/config.json" ]; then
  echo The config file is missing
  echo The system is not correctly installed
  echo Please run $(basename $0) install
  exit 1
fi

##
# START / STOP
##
if [ "${1}" = "start" ] || [ "${1}" = "stop" ] || [ "${1}" = "restart" ]; then

  cd node

  if [ "${1}" = "start" ]; then
    start
  fi

  if [ "${1}" == "stop" ]; then
    stop
  fi

  if [ "${1}" == "restart" ]; then
    stop
    sleep 2
    start
  fi

fi

##
# UPDATE
##
if [ "${1}" = "update" ]; then
  cd node
#  echo "Updating npm..."
#  curl -s http://npmjs.org/install.sh | sudo sh
  echo "Updating node modules. This might take a while..."
  npm update
fi

##
# TEST
##
if [ "${1}" = "test" ]; then
  cd node
  echo -n "Test if log directory is writable: $(dirname ${LOGFILE}) "
  check_logdir
  [ $? != 0 ] && { echo -e [${C_KO}]; } || { echo -e [${C_OK}]; }
  echo -n "Test if config is correct "
  check_config
  [ $? != 0 ]  && { echo -e [${C_KO}]; } || { echo -e [${C_OK}]; }
  echo -n "Test if the stash is accessible "
  check_stash
  [ $? != 0 ]  && { echo -e [${C_KO}]; } || { echo -e [${C_OK}]; }
fi

##
# LOG
##
if [ "${1}" = "log" ]; then
  echo Reading ${LOGFILE}
  tail -f -n 100 -f ${LOGFILE}
fi

##
# STATUS
##
if [ "${1}" = "status" ]; then
  echo "Showing node.js processes. You should see at least 'node server', 'node ehs' and 'node mhs'"
  ps o args= -p $(ps axo pid,command,args | grep -i "node" | grep -v grep | awk '{ print $1 }') 2> /dev/null
fi

##
# INSTALLER
##
if [ "${1}" = "install" ]; then

  check_node 

  if [ $? != 0 ]; then
    echo "You're running a wrong version of node, you're using $NODE_VERSION, we need at least v0.6.0" >&2
    exit 1
  fi

  rm -f .install

  if [ ! -f "conf/config.json" ]; then
    echo "Creating the settings file config.json..."
    cp -v conf/config.json.template conf/config.json || exit 1
    echo ==============================================================
    echo "You now have to edit config.json and supply the correct values"
    echo "Once the editing will be finished, the install process will continue"
    echo "If you prefer you can always edit the file with you editor of choice"
    echo "once the install process is ended"
    echo
    echo "Remember that whenever you'll have to modify the config.json file"
    echo "you will then need to restart the whole server for the changes to"
    echo "take effect"
    echo
    echo "Press a key to start editing"
    echo ==============================================================
    read x
    vi conf/config.json
  fi

  cd node

  echo Installing node.js modules. This may take a while...

  npm install

  if [ $? != 0 ]; then
    echo Sorry, something went wrong during the module installation. Installation NOT completed.
    exit 1
  fi

  touch ../.install

  echo
  echo Success!
  echo The system appears to be correctly installed.

fi

