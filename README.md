# device-switcher

A Claude Code mod that adds a **裝置切換 (device switcher)** pane beside the chat. Pick a device in the pane and Claude reads, writes and runs commands on that device over SSH instead of on the local computer.

## What it does

- **Pane**: shows the active device, switches with one press, adds devices (`名稱 user@host[:port] [遠端資料夾]`), tests and removes them. Hosts in `~/.ssh/config` can be added with one press.
- **Bash** commands are sent to the active device over `ssh` automatically.
- **Local file tools** (Read, Write, Edit, Glob, Grep, PowerShell) are refused while a remote device is active, and Claude is told to use Bash instead.
- `/device` opens the pane, `/device <name>` switches, `/device local` goes back to this computer.

## Setup

Each device needs SSH enabled and key-based login (no password prompt), because the mod connects with `BatchMode=yes`. The device list is kept per computer.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install device-switcher --marketplace andykwsc/claude_mod_device_manager
```

Answer `y` to add the marketplace, then pick the user scope.

From a shell:

```
claude plugin install device-switcher --marketplace andykwsc/claude_mod_device_manager
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `andykwsc/claude_mod_device_manager`, then Add plugin.

This repository is private: installing needs read access on GitHub and a git credential for github.com on that computer (an SSH key, or `gh auth login` then `gh auth setup-git`).
