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
  // The keys below are a draft for native review (unit U2).
  'start.intro':
    '<b>گزارش حساب‌ها و پیوندهای آسیب‌زا</b>\n\nپیوند حساب یا پستی در شبکه‌های اجتماعی را که اطلاعات خصوصی افراد را منتشر می‌کند، به کودکی آسیب می‌زند، کسی را آزار می‌دهد یا آسیبی از این دست می‌رساند برایم بفرستید و به چند پرسش کوتاه پاسخ دهید.\n\nمدیران همهٔ گزارش‌ها را بررسی می‌کنند. گزارش‌های تأییدشده همراه با راهنمای گزارش‌دادن در همان پلتفرم در کانال منتشر می‌شوند: نتیجه‌ها همان‌جا دیده می‌شوند و دربارهٔ تصمیم پیامی برای شما فرستاده نمی‌شود.\n\nپیام‌های شما را در این گفت‌وگو بلافاصله پس از خواندن پاک می‌کنم.',
  'start.keyholder':
    '<b>شما کلیددار هستید.</b> هشدارها اینجا به دستتان می‌رسد: اعلان‌های تأیید با دکمه‌های لغو و قفل، و هشدارهای ربات. برای قفل کردن ربات /lockdown و برای برداشتن قفل /unlock را بفرستید؛ هر دو فقط در همین گفت‌وگو کار می‌کنند.',
  'keyholder.lockdown_is_on': 'قفل اضطراری فعال است.',
  'lockdown.unavailable': 'ربات موقتاً در دسترس نیست. لطفاً بعداً دوباره تلاش کنید.',
  'lockdown.on':
    '<b>قفل اضطراری فعال شد.</b> گزارشی پذیرفته نمی‌شود، فشار دکمه‌ها شمرده نمی‌شود، همهٔ کارهای مدیران رد می‌شود، چیزی منتشر نمی‌شود و هشدارها فقط به کلیدداران می‌رسد. برای برداشتن قفل /unlock را بفرستید.',
  'lockdown.already_on': 'قفل اضطراری از پیش فعال بود.',
  'lockdown.off': '<b>قفل اضطراری برداشته شد.</b>',
  'lockdown.was_off': 'قفل اضطراری فعال نبود.',
  'lockdown.override_on':
    'قفل استقرار (<code>LOCKDOWN</code>) هنوز تنظیم شده است، پس ربات قفل می‌ماند تا وقتی که با <code>wrangler secret delete LOCKDOWN</code> برداشته شود.',
  'admin.refused': 'این کار اکنون پذیرفته نمی‌شود.',
  'language.set': 'زبان: فارسی.',
  'language.usage': 'زبان را انتخاب کنید: /language fa برای فارسی، /language en برای انگلیسی.',
  'press.thanks': 'سپاس که گزارش دادید.',
  'fallback.help': 'برای دیدن طرز کار این ربات، /start را بفرستید.',
  'post.warning':
    'هرگز از دستورهایی پیروی نکنید که شما را به باز کردن پیوندهای دیگر، پیوستن به یک گفت‌وگو یا زدن دکمهٔ Start فرامی‌خوانند، هر کس که آن‌ها را نوشته باشد.',
};
