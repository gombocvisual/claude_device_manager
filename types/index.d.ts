export type Device = {
  id: string
  name: string
  target: string
  port?: number
  dir?: string
}

declare module 'claude-code' {
  interface PluginState {
    'device-switcher': {
      devices: Shaped<Device[]>
      active: Shaped<string>
      message: string
      sshHosts: string[]
    }
  }
}
