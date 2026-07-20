type Action = "shutdown" | "restart" | "sleep" | "cancel";

main();

async function main() {
  const command = getCommand("shutdown", Deno.build.os);
  const [program, ...commandArgs] = command;
  if (!program) throw new Error("No command configured.");

  const child = new Deno.Command(program, { args: commandArgs });
  const result = await child.output();
  if (!result.success) {
    const error = new TextDecoder().decode(result.stderr).trim();
    await Deno.writeTextFile("error.log", error);
  }
}

function getCommand(action: Action, os: typeof Deno.build.os): string[] {
  if (os === "darwin") return getMacCommand(action);
  if (os === "linux") return getLinuxCommand(action);
  if (os === "windows") return getWindowsCommand(action);

  throw new Error(`Unsupported OS: ${os}`);
}

function getMacCommand(action: Action): string[] {
  const commands: Record<Action, string[]> = {
    shutdown: ["osascript", "-e", 'tell application "System Events" to shut down'],
    restart: ["osascript", "-e", 'tell application "System Events" to restart'],
    sleep: ["pmset", "sleepnow"],
    cancel: ["sudo", "killall", "shutdown"],
  };
  return commands[action];
}

function getLinuxCommand(action: Action): string[] {
  const commands: Record<Action, string[]> = {
    shutdown: ["systemctl", "poweroff"],
    restart: ["systemctl", "reboot"],
    sleep: ["systemctl", "suspend"],
    cancel: ["shutdown", "-c"],
  };
  return commands[action];
}

function getWindowsCommand(action: Action): string[] {
  const commands: Record<Action, string[]> = {
    shutdown: ["shutdown", "/s", "/t", "0"],
    restart: ["shutdown", "/r", "/t", "0"],
    sleep: ["rundll32.exe", "powrprof.dll,SetSuspendState", "0,1,0"],
    cancel: ["shutdown", "/a"],
  };
  return commands[action];
}
