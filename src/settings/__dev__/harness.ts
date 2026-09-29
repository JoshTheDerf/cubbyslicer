/** Dev-only harness: `npm run dev` → /slicer/src/settings/__dev__/harness.html */
import { createApp, h } from 'vue';
import ui from '@nuxt/ui/vue-plugin';
import UApp from '@nuxt/ui/components/App.vue';
import '../../ui/theme.css';
import '../../style.css';
import SettingsPanel from '../SettingsPanel.vue';

createApp({ render: () => h(UApp, null, { default: () => h(SettingsPanel) }) }).use(ui).mount('#app');
