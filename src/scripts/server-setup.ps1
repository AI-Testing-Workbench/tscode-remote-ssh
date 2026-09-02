# Server installation script

$TMP_DIR="$env:TEMP\$([System.IO.Path]::GetRandomFileName())"
$ProgressPreference = "SilentlyContinue"

$DISTRO_COMMIT="%%DISTRO_COMMIT%%"

$SERVER_APP_NAME="%%SERVER_APP_NAME%%"
$SERVER_INITIAL_EXTENSIONS="%%SERVER_INITIAL_EXTENSIONS%%"
$SERVER_LISTEN_FLAG="%%SERVER_LISTEN_FLAG%%"
$SERVER_DATA_DIR="%%SERVER_DATA_DIR%%"
$SERVER_DIR="$SERVER_DATA_DIR\bin\$DISTRO_COMMIT"
$SERVER_SCRIPT="$SERVER_DIR\bin\$SERVER_APP_NAME.cmd"
$SERVER_LOGFILE="$SERVER_DATA_DIR\.$DISTRO_COMMIT.log"
$SERVER_PIDFILE="$SERVER_DATA_DIR\.$DISTRO_COMMIT.pid"
$SERVER_TOKENFILE="$SERVER_DATA_DIR\.$DISTRO_COMMIT.token"
$SERVER_CONNECTION_TOKEN=
$SERVER_VALIDATION_FLAG="%%SERVER_VALIDATION_FLAG%%"

$LISTENING_ON=
$OS_RELEASE_ID=
$ARCH=
$PLATFORM="win32"
$ERROR_MESSAGE=

function printInstallResults($code) {
  "%%SCRIPT_ID%%: start"
  "exitCode==$code=="
  "listeningOn==$LISTENING_ON=="
  "connectionToken==$SERVER_CONNECTION_TOKEN=="
  "logFile==$SERVER_LOGFILE=="
  "osReleaseId==$OS_RELEASE_ID=="
  "arch==$ARCH=="
  "platform==$PLATFORM=="
  "tmpDir==$TMP_DIR=="
  "error==$ERROR_MESSAGE=="
%%ENV_VAR_LINES%%
  "%%SCRIPT_ID%%: end"
}

# Check machine architecture
$ARCH=$env:PROCESSOR_ARCHITECTURE

$SERVER_SCRIPT_ITEM = Get-Item $SERVER_SCRIPT -ErrorAction SilentlyContinue
if(!$SERVER_SCRIPT_ITEM -or $SERVER_SCRIPT_ITEM.Length -eq 0) {
  $ERROR_MESSAGE="Remote server script not found or empty: $SERVER_SCRIPT"
  "Error: $ERROR_MESSAGE"
  printInstallResults 1
  exit 0
}

"Server script found in $SERVER_SCRIPT"

# Try to find if server is already running
if(Get-Process node -ErrorAction SilentlyContinue | Where-Object Path -Like "$SERVER_DIR\*") {
  echo "Server script is already running $SERVER_SCRIPT"
}
else {
  if(Test-Path $SERVER_LOGFILE) {
    del $SERVER_LOGFILE
  }
  if(Test-Path $SERVER_PIDFILE) {
    del $SERVER_PIDFILE
  }
  if(Test-Path $SERVER_TOKENFILE) {
    del $SERVER_TOKENFILE
  }

  $SERVER_CONNECTION_TOKEN="%%SERVER_CONNECTION_TOKEN%%"
  [System.IO.File]::WriteAllLines($SERVER_TOKENFILE, $SERVER_CONNECTION_TOKEN)

  $SCRIPT_ARGUMENTS="--start-server --host=127.0.0.1 $SERVER_LISTEN_FLAG $SERVER_VALIDATION_FLAG $SERVER_INITIAL_EXTENSIONS --connection-token-file $SERVER_TOKENFILE --telemetry-level off --enable-remote-auto-shutdown --accept-server-license-terms *> '$SERVER_LOGFILE'"

  $START_ARGUMENTS = @{
    FilePath = "powershell.exe"
    WindowStyle = "hidden"
    ArgumentList = @(
      "-ExecutionPolicy", "Unrestricted", "-NoLogo", "-NoProfile", "-NonInteractive", "-c", "$SERVER_SCRIPT $SCRIPT_ARGUMENTS"
    )
    PassThru = $True
  }

  $SERVER_ID = (start @START_ARGUMENTS).ID

  if($SERVER_ID) {
    [System.IO.File]::WriteAllLines($SERVER_PIDFILE, $SERVER_ID)
  }
}

if(Test-Path $SERVER_TOKENFILE) {
  $SERVER_CONNECTION_TOKEN="$(cat $SERVER_TOKENFILE)"
}
else {
  "Error server token file not found $SERVER_TOKENFILE"
  printInstallResults 1
  exit 0
}

sleep -Milliseconds 500

$SELECT_ARGUMENTS = @{
  Path = $SERVER_LOGFILE
  Pattern = "Extension host agent listening on (\d+)"
}

for($I = 1; $I -le 5; $I++) {
  if(Test-Path $SERVER_LOGFILE) {
    $GROUPS = (Select-String @SELECT_ARGUMENTS).Matches.Groups

    if($GROUPS) {
      $LISTENING_ON = $GROUPS[1].Value
      break
    }
  }

  sleep -Milliseconds 500
}

if(!(Test-Path $SERVER_LOGFILE)) {
  "Error server log file not found $SERVER_LOGFILE"
  printInstallResults 1
  exit 0
}

# Finish server setup
printInstallResults 0

if($SERVER_ID) {
  while($True) {
    if(!(gps -Id $SERVER_ID)) {
      "server died, exit"
      exit 0
    }

    sleep 30
  }
}
