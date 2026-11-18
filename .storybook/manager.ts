import { addons } from 'storybook/manager-api';
import { create } from 'storybook/theming/create';

addons.setConfig({
  theme: create({
    base: 'dark', brandTitle: 'Vista Verde laboratory', brandUrl: '/app', brandTarget: '_self',
    colorPrimary: '#e1eab6', colorSecondary: '#c4d594', appBg: '#0d271e', appContentBg: '#17372b',
  }),
});
