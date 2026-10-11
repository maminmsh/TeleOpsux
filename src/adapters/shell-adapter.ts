import { BaseAdapter } from "./base-adapter";
import { CreateSessionOptions } from "./agent-adapter";

export class ShellAdapter extends BaseAdapter {
  readonly id = "shell";
  readonly name = "Shell";

  constructor(private shell = "bash") {
    super();
  }

  launchCommand(options: CreateSessionOptions): string {
    // A plain interactive shell in the project directory.
    void options;
    return this.shell;
  }

  initialInput(options: CreateSessionOptions): string | undefined {
    return options.task;
  }

  override inputPatterns = [
    /[\$#%>]\s*$/, // classic PS1 prompt -> waiting for a command
  ];
}
