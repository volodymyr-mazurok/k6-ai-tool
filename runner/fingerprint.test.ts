import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appBundle } from './fingerprint.js';

test('appBundle: a main-<HASH>.js bundle wins over any other hashed bundle', () => {
  assert.equal(appBundle('<script src="/vendor.1a2b3c4d.js"></script><script src="main-ABCD1234.js"></script>'), 'main-ABCD1234.js');
  assert.equal(appBundle('<script src="main-SELFTEST.js"></script>'), 'main-SELFTEST.js', 'the name the mock serves');
});

test('appBundle: without one, the first <name>-<hash>.js or <name>.<hash>.js with a hash of 8+ letters and digits', () => {
  assert.equal(appBundle('<script type="module" src="/assets/index-D4f5aB9c.js"></script>'), 'index-D4f5aB9c.js', 'Vite');
  assert.equal(appBundle('<script src="/static/js/main.3f2a9b1c.js"></script>'), 'main.3f2a9b1c.js', 'Create React App');
  assert.equal(appBundle('<script src="/_next/static/chunks/app-0123456789abcdef.js"></script>'), 'app-0123456789abcdef.js', 'Next.js');
  assert.equal(appBundle('<SCRIPT SRC="/APP.ABCDEF12.JS"></SCRIPT>'), 'APP.ABCDEF12.JS', 'any letter case');
});

test('appBundle: no hashed bundle, no name (the swagger hash alone tells a deploy)', () => {
  assert.equal(appBundle('<script src="/js/jquery.min.js"></script><script src="/lib/jquery.validate.js"></script>'), undefined, 'a hash has a digit');
  assert.equal(appBundle('<script src="/app.1234.js"></script>'), undefined, 'a hash has 8 characters or more');
  assert.equal(appBundle('<html><body>no scripts</body></html>'), undefined);
});

test('appBundle: only same-origin script tags count, and the last hashed one wins', () => {
  const app = 'https://app.example.test/';
  const page = [
    '<script src="https://cdn.thirdparty.example/widget.1a2b3c4d5e.js"></script>',
    '<script src="/assets/vendor-AbC12345.js"></script>',
    '<script src="https://app.example.test/assets/index-D4f5aB9c.js"></script>',
  ].join('');
  assert.equal(appBundle(page, app), 'index-D4f5aB9c.js', 'the last same-origin bundle (the app entry comes last)');
  assert.equal(
    appBundle('<script src="//cdn.thirdparty.example/lib-12345678.js"></script><script src="https://other.example/x.abcdef12.js"></script>', app),
    undefined,
    'a versioned third-party script never reads as the app build',
  );
  assert.equal(appBundle("<script type='module' src='./index-11aa22bb.js'></script>", app), 'index-11aa22bb.js', 'single quotes, relative path');
  assert.equal(appBundle('<script src="https://cdn.example/main-ABCD1234.js"></script>', app), 'main-ABCD1234.js', 'an Angular main bundle is read wherever it is served from');
  assert.equal(
    appBundle('<script data-src="https://cdn/widget-1a2b3c4d5e.js" src="/assets/index-D4f5aB9c.js"></script>', app),
    'index-D4f5aB9c.js',
    'a data-src before the real src is not read as the src',
  );
  assert.equal(
    appBundle('<script type="text/plain" data-src="/x/tracker-9z8y7x6w5.js"></script>', app),
    undefined,
    'a held script (data-src only) is not the app build',
  );
});
