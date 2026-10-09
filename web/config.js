/* Public settings only. Configure all runtime credentials in Makers. */
window.MVS_SITE = Object.freeze({
  minecraft: '26.3',
  fabric: '0.19.5',
  java: '25',
  sourceVersion: '0.1.0',
  // Opt in after configuring RCON and Blob; online player names are public.
  publicStatusEnabled: false,
  links: Object.freeze({
    repo: 'https://cnb.cool/Mintimate/tool-forge/minecraft-vanilla-stack',
    mirror: 'https://github.com/Mintimate/minecraft-vanilla-stack',
    releases: 'https://cnb.cool/Mintimate/tool-forge/minecraft-vanilla-stack/-/releases',
    hmcl: 'https://hmcl.huangyuhui.net/download/',
    eula: 'https://www.minecraft.net/eula',
    resourcepack: 'https://modrinth.com/resourcepack/xk-redstone-display',
  }),
  docsBase: 'https://cnb.cool/Mintimate/tool-forge/minecraft-vanilla-stack/-/blob/main/docs/',
});
