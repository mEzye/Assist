const {
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  TFile,
  normalizePath,
  requestUrl,
} = require('obsidian');
module.exports = class AssistSync extends Plugin {
  async onload() {
    this.settings = Object.assign(
      {
        url: '',
        code: '',
        folder: 'Assist',
        token: '',
        boardId: '',
        files: {},
      },
      await this.loadData(),
    );
    this.addSettingTab(new Settings(this.app, this));
    this.addCommand({
      id: 'sync-now',
      name: 'Sync now',
      callback: () => this.sync(),
    });
    this.registerEvent(this.app.vault.on('modify', () => this.schedule()));
    this.registerEvent(this.app.vault.on('create', () => this.schedule()));
    this.registerEvent(this.app.vault.on('delete', () => this.schedule()));
    this.registerEvent(
      this.app.vault.on('rename', (file, old) => {
        for (const entry of Object.values(this.settings.files))
          if (entry.path === old && this.inside(file.path))
            entry.path = file.path;
        this.schedule();
      }),
    );
    this.app.workspace.onLayoutReady(() => this.sync());
    this.registerInterval(window.setInterval(() => this.sync(), 60000));
  }
  inside(path) {
    return path.startsWith(this.settings.folder.replace(/\/$/, '') + '/');
  }
  unpack(text) {
    let id;
    const body = text.replace(
      /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/,
      (_all, start, meta, end) => {
        const lines = meta.split(/\r?\n/);
        const rest = lines.filter((line) => {
          const match = /^assist-id:\s*([a-f0-9-]+)\s*$/.exec(line);
          if (match) {
            id = match[1];
            return false;
          }
          return true;
        });
        return rest.length ? start + rest.join('\n') + end : '';
      },
    );
    return { id, body };
  }
  pack(body, id) {
    if (/^---\r?\n/.test(body))
      return body.replace(/^(---\r?\n)/, `$1assist-id: ${id}\n`);
    return `---\nassist-id: ${id}\n---\n${body}`;
  }
  async save() {
    await this.saveData(this.settings);
  }
  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.sync(), 2500);
  }
  async api(path, method = 'GET', body) {
    const r = await requestUrl({
      url: this.settings.url.replace(/\/$/, '') + path,
      method,
      headers: {
        Authorization: 'Bearer ' + this.settings.token,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      throw: false,
    });
    if (r.status >= 400) {
      const e = new Error(r.json?.error || `HTTP ${r.status}`);
      e.status = r.status;
      e.response = r.json;
      throw e;
    }
    return r.json;
  }
  async pair() {
    try {
      const r = await this.api('/api/obsidian/claim', 'POST', {
        code: this.settings.code,
      });
      this.settings.token = r.token;
      this.settings.boardId = r.boardId;
      this.settings.code = '';
      this.settings.files = {};
      await this.save();
      new Notice('Assist: connected');
      await this.sync();
    } catch (e) {
      new Notice('Assist: ' + e.message);
    }
  }
  async uniquePath(title) {
    let base = title.replace(/[\\/:*?"<>|#^[\]]/g, '-').trim() || 'Untitled';
    let path = normalizePath(`${this.settings.folder}/${base}.md`),
      i = 1;
    while (this.app.vault.getAbstractFileByPath(path))
      path = normalizePath(`${this.settings.folder}/${base} ${i++}.md`);
    return path;
  }
  async conflict(entry) {
    const f = this.app.vault.getAbstractFileByPath(entry.path);
    if (f instanceof TFile) {
      const body = this.unpack(await this.app.vault.read(f)).body;
      const path = await this.uniquePath(f.basename + ' (conflict)');
      await this.app.vault.create(path, body);
    }
  }
  async sync() {
    if (
      this.syncing ||
      !this.settings.token ||
      !this.settings.url ||
      !this.settings.folder
    )
      return;
    this.syncing = true;
    try {
      let folder = this.app.vault.getAbstractFileByPath(this.settings.folder);
      if (!folder) await this.app.vault.createFolder(this.settings.folder);
      const remote = (await this.api('/api/obsidian/notes')).notes;
      const byId = Object.fromEntries(remote.map((n) => [n.id, n]));
      const entries = this.settings.files;
      for (const [id, entry] of Object.entries(entries)) {
        if (!this.inside(entry.path)) {
          delete entries[id];
          continue;
        }
        const n = byId[id];
        const f = this.app.vault.getAbstractFileByPath(entry.path);
        if (!n) {
          if (f instanceof TFile) {
            const content = this.unpack(await this.app.vault.read(f)).body;
            if (content !== entry.body || f.basename !== entry.title)
              await this.conflict(entry);
            await this.app.vault.delete(f);
          }
          delete entries[id];
          continue;
        }
        if (!(f instanceof TFile)) {
          if (n.revision !== entry.revision) {
            const path = await this.uniquePath(n.title);
            await this.app.vault.create(path, this.pack(n.body, n.id));
            entries[id] = {
              path,
              body: n.body,
              title: n.title,
              revision: n.revision,
            };
          } else {
            try {
              await this.api(
                '/api/obsidian/notes/' + id + '?revision=' + entry.revision,
                'DELETE',
              );
              delete entries[id];
            } catch (e) {
              if (e.status !== 409) throw e;
            }
          }
          continue;
        }
        const body = this.unpack(await this.app.vault.read(f)).body,
          title = f.basename;
        const localChanged = body !== entry.body || title !== entry.title,
          remoteChanged = n.revision !== entry.revision;
        if (localChanged && remoteChanged) {
          await this.conflict(entry);
        } else if (localChanged) {
          try {
            const updated = await this.api(
              '/api/obsidian/notes/' + id,
              'PATCH',
              { title, body, revision: entry.revision },
            );
            entries[id] = {
              path: f.path,
              body,
              title,
              revision: updated.revision,
            };
            continue;
          } catch (e) {
            if (e.status !== 409) throw e;
            await this.conflict(entry);
            Object.assign(n, e.response.note);
          }
        }
        if (remoteChanged || localChanged) {
          if (f.basename !== n.title) {
            const target = await this.uniquePath(n.title);
            await this.app.fileManager.renameFile(f, target);
          }
          await this.app.vault.modify(f, this.pack(n.body, n.id));
          entries[id] = {
            path: f.path,
            body: n.body,
            title: n.title,
            revision: n.revision,
          };
        }
      }
      for (const f of this.app.vault
        .getMarkdownFiles()
        .filter((f) => this.inside(f.path))) {
        const parsed = this.unpack(await this.app.vault.read(f));
        const n = parsed.id && byId[parsed.id];
        if (n && !entries[n.id]) {
          if (parsed.body !== n.body || f.basename !== n.title) {
            const path = await this.uniquePath(f.basename + ' (conflict)');
            await this.app.vault.create(path, parsed.body);
          }
          await this.app.vault.modify(f, this.pack(n.body, n.id));
          entries[n.id] = {
            path: f.path,
            body: n.body,
            title: n.title,
            revision: n.revision,
          };
        }
      }
      for (const n of remote) {
        if (entries[n.id]) continue;
        const path = await this.uniquePath(n.title);
        await this.app.vault.create(path, this.pack(n.body, n.id));
        entries[n.id] = {
          path,
          body: n.body,
          title: n.title,
          revision: n.revision,
        };
      }
      const tracked = new Set(Object.values(entries).map((e) => e.path));
      for (const f of this.app.vault
        .getMarkdownFiles()
        .filter(
          (f) =>
            f.path.startsWith(this.settings.folder.replace(/\/$/, '') + '/') &&
            !tracked.has(f.path),
        )) {
        if (/ \(conflict\)( \d+)?\.md$/.test(f.path)) continue;
        const parsed = this.unpack(await this.app.vault.read(f));
        const body = parsed.body;
        let n = parsed.id && byId[parsed.id];
        if (n && !entries[n.id]) {
          if (n.body !== body || n.title !== f.basename) {
            const path = await this.uniquePath(f.basename + ' (conflict)');
            await this.app.vault.create(path, body);
          }
          await this.app.vault.modify(f, this.pack(n.body, n.id));
          entries[n.id] = {
            path: f.path,
            body: n.body,
            title: n.title,
            revision: n.revision,
          };
          continue;
        }
        n = await this.api('/api/obsidian/notes', 'POST', {
          title: f.basename,
          body,
        });
        await this.app.vault.modify(f, this.pack(body, n.id));
        entries[n.id] = {
          path: f.path,
          body,
          title: f.basename,
          revision: n.revision,
        };
      }
      await this.save();
    } catch (e) {
      console.error('Assist sync', e);
      new Notice('Assist sync: ' + e.message);
    } finally {
      this.syncing = false;
    }
  }
};
class Settings extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Assist sync' });
    new Setting(containerEl)
      .setName('Assist URL')
      .setDesc('Your Assist website, including https://')
      .addText((t) =>
        t.setValue(this.plugin.settings.url).onChange(async (v) => {
          this.plugin.settings.url = v.trim();
          await this.plugin.save();
        }),
      );
    new Setting(containerEl)
      .setName('Folder')
      .setDesc('A folder in this vault, dedicated to this board')
      .addText((t) =>
        t.setValue(this.plugin.settings.folder).onChange(async (v) => {
          while (this.plugin.syncing)
            await new Promise((resolve) => setTimeout(resolve, 100));
          this.plugin.settings.folder = normalizePath(v.trim());
          await this.plugin.save();
        }),
      );
    new Setting(containerEl)
      .setName('Pairing code')
      .setDesc(
        'Create a code for a board in Assist. Codes expire after 10 minutes.',
      )
      .addText((t) =>
        t.setValue(this.plugin.settings.code).onChange(async (v) => {
          this.plugin.settings.code = v.trim();
          await this.plugin.save();
        }),
      )
      .addButton((b) =>
        b.setButtonText('Pair').onClick(() => this.plugin.pair()),
      );
    new Setting(containerEl)
      .setName('Sync now')
      .addButton((b) =>
        b.setButtonText('Sync').onClick(() => this.plugin.sync()),
      );
  }
}
