import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { translationResources } from '@dar/i18n';

void i18next
  .use(initReactI18next)
  .init({
    resources: translationResources,
    lng: 'zh-CN',
    fallbackLng: 'zh-CN',
    supportedLngs: ['zh-CN'],
    defaultNS: 'translation',
    interpolation: { escapeValue: false },
  });

export { i18next };
