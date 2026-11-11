import { createApp } from 'vue';
import ui from '@nuxt/ui/vue-plugin';
import App from './App.vue';
import * as projectStore from './project/store';
import * as actions from './app/actions';
import * as presetStore from './presets/store';
import * as cadCommands from './cad/commands';
import * as designDebug from './design/debug';
import { installViewportVars } from './ui/mobileDialog';
import { guardOpenSubmenus } from './ui/submenuGuard';
import './ui/theme.css';
import './style.css';

installViewportVars();
// Every dropdown / context menu: an open submenu must not close on a move over its own trigger (Reka bug).
guardOpenSubmenus();
createApp(App).use(ui).mount('#app');

// Debug handle for browser automation (dev, or ?cubby-debug in a build).
if (import.meta.env.DEV || new URLSearchParams(location.search).has('cubby-debug')) {
  Object.assign(window, { __cubbyProject: projectStore, __cubbyActions: actions, __cubbyPresets: presetStore, __cubbyCad: cadCommands, __cubbyDesign: designDebug });
  void import('./app/debugUi').then((m) => Object.assign(window, { __cubbyUi: m }));
}
