const path = require('path');

module.exports = {
  packagerConfig: {
    asar: true,
    name: 'Claude CMD UI',
    icon: path.join(__dirname, 'images', 'code_squad')
  },
  rebuildConfig: {},
  plugins: [
    { name: '@electron-forge/plugin-auto-unpack-natives', config: {} }
  ]
};
