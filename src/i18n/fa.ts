// The Persian catalog: exactly the keys of src/i18n/en.ts (the type makes a
// missing or an extra key a build error; src/i18n/catalog.test.ts checks the
// keys, the placeholders and the Telegram HTML of both catalogs). The rules
// for the strings are in the header of src/i18n/en.ts.
import type { MessageKey } from './en';

export const fa: Readonly<Record<MessageKey, string>> = {
  'error.unexpected': 'مشکلی پیش آمد. لطفاً بعداً دوباره تلاش کنید.',
  'error.invalid_input': 'این ورودی معتبر نیست. لطفاً آن را بررسی کنید و دوباره تلاش کنید.',
  'error.rate_limited': 'به سقف مجاز رسیدید. لطفاً بعداً دوباره تلاش کنید.',
  'error.not_a_member': 'این امکان فقط برای اعضای سازمان فراهم است.',
  'error.unauthorized': 'شما مجاز به انجام این کار نیستید.',
  'alert.config_invalid':
    '<b>خطای پیکربندی.</b> ربات نتوانست پیکربندی خود را بارگذاری کند. این متغیرها را بررسی کنید: <code>{variables}</code>',
};
