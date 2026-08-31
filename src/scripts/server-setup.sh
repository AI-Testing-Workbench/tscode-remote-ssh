# Server installation script

TMP_DIR="${XDG_RUNTIME_DIR:-"/tmp"}"

DISTRO_COMMIT="%%DISTRO_COMMIT%%"

SERVER_APP_NAME="%%SERVER_APP_NAME%%"
SERVER_INITIAL_EXTENSIONS="%%SERVER_INITIAL_EXTENSIONS%%"
SERVER_LISTEN_FLAG="%%SERVER_LISTEN_FLAG%%"
SERVER_DATA_DIR="%%SERVER_DATA_DIR%%"
SERVER_DATA_DIR_FLAG="%%SERVER_DATA_DIR_FLAG%%"
SERVER_DIR="$SERVER_DATA_DIR/bin/$DISTRO_COMMIT"
SERVER_SCRIPT="$SERVER_DIR/bin/$SERVER_APP_NAME"
SERVER_LOGFILE="$SERVER_DATA_DIR/.$DISTRO_COMMIT.log"
SERVER_PIDFILE="$SERVER_DATA_DIR/.$DISTRO_COMMIT.pid"
SERVER_TOKENFILE="$SERVER_DATA_DIR/.$DISTRO_COMMIT.token"
SERVER_CONNECTION_TOKEN=
SERVER_VALIDATION_FLAG="%%SERVER_VALIDATION_FLAG%%"

LISTENING_ON=
OS_RELEASE_ID=
ARCH=
PLATFORM=
ERROR_MESSAGE=

# Mimic output from logs of remote-ssh extension
print_install_results_and_exit() {
  echo "%%SCRIPT_ID%%: start"
  echo "exitCode==$1=="
  echo "listeningOn==$LISTENING_ON=="
  echo "connectionToken==$SERVER_CONNECTION_TOKEN=="
  echo "logFile==$SERVER_LOGFILE=="
  echo "osReleaseId==$OS_RELEASE_ID=="
  echo "arch==$ARCH=="
  echo "platform==$PLATFORM=="
  echo "tmpDir==$TMP_DIR=="
  echo "error==$ERROR_MESSAGE=="
%%ENV_VAR_LINES%%
  echo "%%SCRIPT_ID%%: end"
  exit 0
}

LOCKFILE="$TMP_DIR/server_install.lock"

if command -v flock >/dev/null 2>&1; then
  # Automatic file descriptor allocation ({FD}) requires bash >= 4.1,
  # and macOS still ships bash 3.2, so use a fixed descriptor instead.
  FD=9
  exec 9<>"$LOCKFILE"

  if flock --help 2>&1 | grep -q -- '-w'; then
    # wait 30s to acquire lock, otherwise fail
    flock -x -w 30 $FD || print_install_results_and_exit 1
  else
    ELAPSED=0

    while [[ $ELAPSED -lt 30 ]]; do
        if flock -n -x $FD; then
            break
        fi

        sleep 1

        ELAPSED=$((ELAPSED + 1))
    done

    if [[ $ELAPSED -ge 30 ]]; then
      echo "Warning: flock cannot acquire the install lock"
      print_install_results_and_exit 1
    fi
  fi

  trap "flock -u $FD; trap - EXIT INT HUP; exit" EXIT INT HUP
else
  echo "Warning: flock not available, skipping install lock"
fi

# Check if platform is supported
if ! command -v uname >/dev/null 2>&1; then
  echo "Error: 'uname' command not found, could not get platform/arch data."
  print_install_results_and_exit 1
fi

KERNEL="$(uname -s)"
case $KERNEL in
  Darwin)
    PLATFORM="darwin"
    ;;
  Linux)
    PLATFORM="linux"
    ;;
  FreeBSD)
    PLATFORM="freebsd"
    ;;
  DragonFly)
    PLATFORM="dragonfly"
    ;;
  "")
    echo "Error: uname -s yields empty result"
    print_install_results_and_exit 1
    ;;
  *)
    echo "Error: platform not supported: $KERNEL"
    print_install_results_and_exit 1
    ;;
esac

ARCH="$(uname -m)"

# https://www.freedesktop.org/software/systemd/man/os-release.html
OS_RELEASE_ID="$(grep -i '^ID=' /etc/os-release 2>/dev/null | sed 's/^ID=//gi' | sed 's/"//g')"
if [[ -z $OS_RELEASE_ID ]]; then
  OS_RELEASE_ID="$(grep -i '^ID=' /usr/lib/os-release 2>/dev/null | sed 's/^ID=//gi' | sed 's/"//g')"
  if [[ -z $OS_RELEASE_ID ]]; then
    OS_RELEASE_ID="unknown"
  fi
fi

# Keep the platform name used by the server result for Alpine hosts.
if [[ $OS_RELEASE_ID = alpine ]]; then
  PLATFORM=$OS_RELEASE_ID
fi

# The remote server must be provisioned before this command runs.
if [[ ! -f $SERVER_SCRIPT ]] || [[ ! -s $SERVER_SCRIPT ]]; then
  ERROR_MESSAGE="Remote server script not found or empty: $SERVER_SCRIPT"
  echo "Error: $ERROR_MESSAGE"
  print_install_results_and_exit 1
fi

echo "Server script found in $SERVER_SCRIPT"

# Modify the commit in the remote server to match the local value
if %%MODIFY_PRODUCT_JSON%%; then
  if command -v sed >/dev/null 2>&1; then
    echo "Will modify product.json on remote to match the commit value"
    sed -i -E 's/"commit": "[0-9a-f]+",/"commit": "'"$DISTRO_COMMIT"'",/' "$SERVER_DIR/product.json";
  else
    echo "Cannot find the 'sed' command, make sure it is installed to modify product.json with the matching commit."
  fi
fi

# Try to find if server is already running
if [[ -f $SERVER_PIDFILE ]]; then
  SERVER_PID="$(cat $SERVER_PIDFILE)"
  SERVER_RUNNING_PROCESS="$(ps -o pid,args -p $SERVER_PID | grep $SERVER_SCRIPT)"
else
  SERVER_RUNNING_PROCESS="$(ps -o pid,args -A | grep $SERVER_SCRIPT | grep -v grep)"
fi

if [[ -z $SERVER_RUNNING_PROCESS ]]; then
  if [[ -f $SERVER_LOGFILE ]]; then
    rm $SERVER_LOGFILE
  fi
  if [[ -f $SERVER_TOKENFILE ]]; then
    rm $SERVER_TOKENFILE
  fi

  touch $SERVER_TOKENFILE
  chmod 600 $SERVER_TOKENFILE
  SERVER_CONNECTION_TOKEN="%%SERVER_CONNECTION_TOKEN%%"
  echo $SERVER_CONNECTION_TOKEN > $SERVER_TOKENFILE

  $SERVER_SCRIPT --start-server --host=127.0.0.1 $SERVER_LISTEN_FLAG $SERVER_DATA_DIR_FLAG $SERVER_VALIDATION_FLAG $SERVER_INITIAL_EXTENSIONS --connection-token-file $SERVER_TOKENFILE --telemetry-level off --enable-remote-auto-shutdown --accept-server-license-terms &> $SERVER_LOGFILE &
  echo $! > $SERVER_PIDFILE
else
  echo "Server script is already running $SERVER_SCRIPT"
fi

if [[ -f $SERVER_TOKENFILE ]]; then
  SERVER_CONNECTION_TOKEN="$(cat $SERVER_TOKENFILE)"
else
  echo "Error: server token file not found $SERVER_TOKENFILE"
  print_install_results_and_exit 1
fi

if [[ -f $SERVER_LOGFILE ]]; then
  for i in {1..35}; do
    if [[ -n "$(cat $SERVER_LOGFILE | grep 'Error loading shared library libstdc++.so')" ]]; then
      echo "Error: missing libstdc++"
      break;
    fi

    LISTENING_ON="$(cat $SERVER_LOGFILE | grep -E 'Extension host agent listening on .+' | sed 's/Extension host agent listening on //')"
    if [[ -n $LISTENING_ON ]]; then
      break
    fi

    sleep 0.5
  done

  if [[ -z $LISTENING_ON ]]; then
    echo "Error: server did not start successfully"
    print_install_results_and_exit 1
  fi
else
  echo "Error: server log file not found $SERVER_LOGFILE"
  print_install_results_and_exit 1
fi

# Finish server setup
print_install_results_and_exit 0
