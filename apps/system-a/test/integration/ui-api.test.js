import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTestServer } from '../helpers/session.js';

test('/ui/ devolve o HTML com CSP sem unsafe-inline e nosniff', async () => {
  const app = buildTestServer();
  try {
    const res = await app.inject({ method: 'GET', url: '/ui/' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /^text\/html/);
    assert.match(res.body, /<script type="module" src="\/ui\/app\.js">/);
    const csp = res.headers['content-security-policy'];
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
  } finally {
    await app.close();
  }
});

test('app.js e ui-core.js saem como JavaScript', async () => {
  const app = buildTestServer();
  try {
    for (const file of ['app.js', 'ui-core.js']) {
      const res = await app.inject({ method: 'GET', url: `/ui/${file}` });
      assert.equal(res.statusCode, 200, file);
      assert.match(res.headers['content-type'], /^text\/javascript/, file);
    }
    const css = await app.inject({ method: 'GET', url: '/ui/styles.css' });
    assert.match(css.headers['content-type'], /^text\/css/);
  } finally {
    await app.close();
  }
});

test('arquivo fora da lista, ../server.js e %2e%2e devolvem 404', async () => {
  const app = buildTestServer();
  try {
    for (const url of [
      '/ui/server.js',
      '/ui/.gitkeep',
      '/ui/../server.js',
      '/ui/..%2fserver.js',
      '/ui/%2e%2e/server.js',
      '/ui/%2e%2e%2fserver.js',
      '/ui/%2e%2e%2f%2e%2e%2fpackage.json',
      '/ui/public/app.js',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 404, url);
      assert.doesNotMatch(res.body, /buildServer|import /, url);
    }
  } finally {
    await app.close();
  }
});

test('/ redireciona para /ui/', async () => {
  const app = buildTestServer();
  try {
    for (const url of ['/', '/ui']) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 302, url);
      assert.equal(res.headers.location, '/ui/', url);
    }
  } finally {
    await app.close();
  }
});

test('rotas da UI não exigem sessão', async () => {
  const app = buildTestServer();
  try {
    for (const url of ['/ui/', '/ui/app.js', '/ui/config.json']) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 200, url);
    }
    assert.equal(app.store.listDenials().length, 0);
  } finally {
    await app.close();
  }
});

test('config.json traz o token da UI, não o A_APP_TOKEN, e no-store', async () => {
  const app = buildTestServer();
  try {
    const res = await app.inject({ method: 'GET', url: '/ui/config.json' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.json().appToken, app.authConfig.uiAppToken);
    assert.ok(!res.body.includes(app.authConfig.appToken));
  } finally {
    await app.close();
  }
});

test('features fica falso sem as rotas de nota e solução', async () => {
  const app = buildTestServer();
  try {
    const res = await app.inject({ method: 'GET', url: '/ui/config.json' });
    assert.deepEqual(res.json().features, { followups: false, solutions: false });
  } finally {
    await app.close();
  }
});

test('features liga quando a rota existe', async () => {
  const app = buildTestServer();
  try {
    // Mesmo caminho que a S1.4/S1.5 vão registrar.
    app.get('/apirest.php/Ticket/:id/ITILFollowup', async () => []);
    app.put('/apirest.php/ITILSolution/:id', async () => ({}));
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/ui/config.json' });
    assert.deepEqual(res.json().features, { followups: true, solutions: true });
  } finally {
    await app.close();
  }
});

test('servidor não sobe se faltar arquivo da UI', () => {
  assert.throws(() => buildTestServer({ uiDir: '/caminho/que/nao/existe' }), /ENOENT/);
});
