import { createApp } from 'vue';
import ui from '@nuxt/ui/vue-plugin';
import App from './App.vue';
import * as projectStore from './project/store';
import * as actions from './app/actions';
import * as presetStore from './presets/store';
import * as cadCommands from './cad/commands';
import { registerPreviewActions } from './preview/actions';
import { registerSettingsActions } from './settings/actions';
import './ui/theme.css';
import './style.css';

createApp(App).use(ui).mount('#app');

// Register every area's commands up front so the palette / shortcuts dialog
// list them even before the lazily-mounted panels have been opened.
registerPreviewActions();
void registerSettingsActions();

// Debug handle for browser automation (dev, or ?cubby-debug in a build).
if (import.meta.env.DEV || new URLSearchParams(location.search).has('cubby-debug')) Object.assign(window, { __cubbyProject: projectStore, __cubbyActions: actions, __cubbyPresets: presetStore, __cubbyCad: cadCommands });
