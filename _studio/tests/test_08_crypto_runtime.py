"""加密运行回归：真实 WebCrypto 密钥环、嵌套密文、密码组与私密媒体打包。"""

from .node_runtime import (
    MOCK_DOM, MOCK_LOCAL_STORAGE, MOCK_SESSION_STORAGE, NodeTestCase, mock_window,
)


class Test08_CryptoRuntime(NodeTestCase):
    """独立进程执行真实 AES-GCM 加解密并检查脱敏状态和密钥轮换。"""

    def test_password_group_window_waits_for_close_and_updates_deleted_group(self):
        """密码组窗口关闭前不返回，删除后更新列表且不靠整页刷新。"""
        body = r"""
        const vm=await import('node:vm'),fs=await import('node:fs');
        const {pathToFileURL}=await import('node:url'),path=await import('node:path');
        const identifier=pathToFileURL(path.resolve('data-manage/encrypt/password-groups.module.js')).href;
        const ring={master_only:true,groups:{one:{name:'删除目标'}}};
        const host={innerHTML:'',querySelectorAll:()=>[]};let options,modal,reloads=0;
        window.location.reload=()=>{reloads++;};
        const overrides={
            './auth-flow.module.js':{ensureUnlocked:async()=>true},
            './crypto.module.js':{getSessionKeysRaw:()=>({default:'master'})},
            './keyring.module.js':{loadKeyring:async()=>ring,passwordGroups:value=>
                Object.entries(value.groups).map(([id,group])=>({...group,id}))},
            './password-group-actions.module.js':{request:async()=>({items:[]}),
                deletePasswordGroup:async id=>{delete ring.groups[id];return true;}},
            './lock-dialog.module.js':{openFormModal:value=>{
                options=value;modal={el:{style:{},isConnected:true,querySelector:selector=>
                    selector==='[data-role="groups"]'?host:__mockEl()},close(){this.el.isConnected=false;}};
                return modal;
            }}
        };
        const module=new vm.SourceTextModule(fs.readFileSync(new URL(identifier),'utf8'),{identifier});
        await module.link(async(specifier,parent)=>{
            const values={...await import(new URL(specifier,parent.identifier)),...overrides[specifier]};
            return new vm.SyntheticModule(Object.keys(values),function(){
                for(const [name,value] of Object.entries(values))this.setExport(name,value);
            });
        });
        await module.evaluate();let finished=false;
        const opened=module.namespace.openPasswordGroups().then(()=>{finished=true;});
        await new Promise(resolve=>setImmediate(resolve));
        assert.equal(finished,false);assert.ok(host.innerHTML.includes('删除目标'));
        await modal.el.onclick({target:{closest:()=>({disabled:false,dataset:{action:'delete',group:'one'}})}});
        assert.ok(!host.innerHTML.includes('删除目标'));assert.equal(finished,false);assert.equal(reloads,0);
        assert.equal(options.onSubmit(),true);await opened;assert.equal(finished,true);assert.equal(reloads,0);
        """
        self.run_node_esm(body, preamble=(MOCK_DOM, MOCK_LOCAL_STORAGE, MOCK_SESSION_STORAGE,
            mock_window('/admin-portal.html')), node_args=('--experimental-vm-modules',))


    def test_content_password_unlocks_all_without_admin_key_and_tracks_new_groups(self):
        """两种全局密码隔离，内容密码全解锁、逐组锁回、新建组和主密钥轮换均保持正确。"""
        body = """
        const C = await import('./data-manage/encrypt/crypto.module.js');
        const K = await import('./data-manage/encrypt/keyring.module.js');
        const { unlockPasswords } = await import('./data-manage/encrypt/group-unlock.module.js');
        const admin = await K.createKeyring('AdminPassword');
        const one = await K.createKeyring('OnePassword', '', { recovery: false });
        const two = await K.createKeyring('TwoPassword', '', { recovery: false });
        assert.equal(one.keyring.rc, undefined);
        assert.equal(one.recoveryCode, null);
        const a = 'g_' + 'a'.repeat(32), b = 'g_' + 'b'.repeat(32);
        const master = await C.importDataKey(admin.dekRaw);
        let ring = { ...admin.keyring, master_only: true, groups: {
            [a]: { ...one.keyring, name: '一组', master_wrap: await K.wrapMasterGroup(a, one.keyring, one.dekRaw, master) }
        } };
        await assert.rejects(K.createContentAccess(ring, 'AdminPassword', admin.dekRaw), /不能.*相同/);
        ring = await K.createContentAccess(ring, 'ReadPassword', admin.dekRaw);
        assert.equal(ring.content.rc, undefined);
        const resetRead = await K.createContentAccess(ring, 'ResetReadPassword', admin.dekRaw);
        assert.equal(await K.unlockWithPassword(resetRead.content, 'ReadPassword'), null);
        assert.ok(await K.unlockWithPassword(resetRead.content, 'ResetReadPassword'));
        const groupRaw = (await K.unwrapMasterGroups(ring, admin.dekRaw)).get(a);
        ring.groups[a] = await K.rewrapPassword(ring.groups[a], groupRaw, 'ResetGroupPassword');
        assert.equal(await K.unlockWithPassword(ring.groups[a], 'OnePassword'), null);
        assert.ok(await K.unlockWithPassword(ring.groups[a], 'ResetGroupPassword'));
        assert.notEqual(ring.content.dek_id, ring.dek_id);
        assert.notEqual(ring.content.dek_id, ring.groups[a].dek_id);
        assert.equal(await K.unlockWithPassword(ring, 'ReadPassword'), null);
        assert.deepEqual(await unlockPasswords(['ReadPassword'], ring), [['content', a]]);
        assert.equal(C.getSessionKeyRaw(), null);
        assert.ok(await C.getSessionKey(a));
        C.clearSessionKey();
        assert.deepEqual(await unlockPasswords(['AdminPassword'], ring), [['default', a]]);
        ring.groups[b] = { ...two.keyring, name: '二组', master_wrap: await K.wrapMasterGroup(b, two.keyring, two.dekRaw, master) };
        ring = await K.refreshContentAccess(ring, admin.dekRaw);
        C.clearSessionKey();
        assert.deepEqual(await unlockPasswords(['ReadPassword'], ring), [['content', a, b]]);
        C.clearSessionKey(a);
        assert.equal(await C.getSessionKey(a), null);
        assert.ok(await C.getSessionKey(b));
        await unlockPasswords(['ReadPassword'], ring);
        assert.ok(await C.getSessionKey(a));
        const rotated = await K.createKeyring('NewAdminPassword');
        const newMaster = await C.importDataKey(rotated.dekRaw);
        const contentKey = await K.unlockWithPassword(ring.content, 'ReadPassword');
        const next = { ...ring, ...rotated.keyring, content: { ...ring.content,
            master_wrap: await K.wrapMasterGroup('content', ring.content, contentKey, newMaster) } };
        next.groups = { ...ring.groups };
        for (const [id, raw] of await K.unwrapMasterGroups(ring, admin.dekRaw)) {
            next.groups[id] = { ...ring.groups[id], master_wrap: await K.wrapMasterGroup(id, ring.groups[id], raw, newMaster) };
        }
        C.clearSessionKey();
        assert.deepEqual(await unlockPasswords(['ReadPassword'], next), [['content', a, b]]);
        assert.equal(C.getSessionKeyRaw(), null);
        C.clearSessionKey();
        const damaged = { ...next, content: { ...next.content, wraps: { [a]: next.content.wraps[b], [b]: next.content.wraps[a] } } };
        await assert.rejects(unlockPasswords(['ReadPassword'], damaged));
        assert.deepEqual(C.getSessionKeysRaw(), {});
        delete next.groups[b];
        const removed = await K.refreshContentAccess(next, rotated.dekRaw);
        assert.deepEqual(Object.keys(removed.content.wraps), [a]);
        const recovered = await K.unlockWithRecovery(rotated.keyring, rotated.recoveryCode);
        let sent;
        globalThis.fetch = async (url, options) => { sent = JSON.parse(options.body); return Response.json({}); };
        await K.saveKeyring(await K.rewrapPassword(removed, recovered, 'ResetAdminPassword'), removed, { masterRaw: recovered });
        assert.equal(sent.masterRaw, undefined);
        assert.equal(C.getSessionKeyRaw(), null);
        assert.ok(await K.unlockWithPassword(await K.loadKeyring(), 'ResetAdminPassword'));
        assert.deepEqual(await unlockPasswords(['ReadPassword'], await K.loadKeyring()), [['content', a]]);
        """
        self.run_node_esm(body, preamble=(MOCK_SESSION_STORAGE, MOCK_DOM,
            mock_window('/index.html', hostname='example.com', is_admin=False)))

    def test_online_admin_entry_requires_fresh_master_and_preserves_group_unlocks(self):
        """首次直达线上后台需验证，组密码不能进入，同一标签页可前后台来回切换。"""
        body = """
        const fs = await import('node:fs');
        const vm = await import('node:vm');
        const { pathToFileURL } = await import('node:url');
        const C = await import('./data-manage/encrypt/crypto.module.js');
        const K = await import('./data-manage/encrypt/keyring.module.js');
        const created = await K.createKeyring('OnlineMasterPassword');
        const { STUDIO_ENTRY_KEY, isOnlineAdminPage } = await import('./data-manage/api-client.module.js');
        const identifier = pathToFileURL(process.cwd() + '/data-manage/encrypt/admin-session.module.js').href;
        const source = fs.readFileSync(new URL(identifier), 'utf8');
        const group = 'g_' + 'a'.repeat(32);
        Object.defineProperty(globalThis, 'performance', { value: { getEntriesByType: () => [{ type: 'navigate' }] } });
        document.referrer = 'https://example.com/index.html';
        globalThis.fetch = async url => {
            assert.ok(!String(url).startsWith('/api/'), '线上验证不得调用本机管理 API');
            return Response.json(created.keyring);
        };
        const compile = async unlock => {
            const module = new vm.SourceTextModule(source, { identifier,
                importModuleDynamically: async specifier => {
                    assert.equal(specifier, './group-unlock.module.js');
                    const fake = new vm.SyntheticModule(['openGroupUnlock'], function() {
                        this.setExport('openGroupUnlock', unlock);
                    });
                    await fake.link(() => {}); await fake.evaluate(); return fake;
                }
            });
            await module.link(async (specifier, parent) => {
                const real = await import(new URL(specifier, parent.identifier));
                return new vm.SyntheticModule(Object.keys(real), function() {
                    for (const key of Object.keys(real)) this.setExport(key, real[key]);
                });
            });
            await module.evaluate(); return module.namespace;
        };
        assert.equal(isOnlineAdminPage(), true);
        assert.equal(isOnlineAdminPage(new URL('http://localhost:8000/admin-portal.html')), false);
        C.setSessionKeyRaw(C.randomBytes(32)); C.setSessionKeyRaw(C.randomBytes(32), group);
        sessionStorage.setItem(STUDIO_ENTRY_KEY, 'logo');
        let prompts = 0;
        const direct = await compile(async options => {
            prompts++;
            assert.equal(C.getSessionKeyRaw(), null, '前端遗留主密钥不代替本次入口验证');
            assert.ok(C.getSessionKeyRaw(group));
            assert.equal(options.reload, false);
            C.setSessionKeyRaw(created.dekRaw); options.onMaster(); return true;
        });
        await Promise.all([direct.ensureOnlineAdminEntry(), direct.ensureOnlineAdminEntry()]);
        assert.equal(prompts, 1);
        assert.equal(sessionStorage.getItem(STUDIO_ENTRY_KEY), 'active');
        document.referrer = 'https://example.com/admin-portal.html';
        const continued = await compile(async () => { throw Error('管理页内导航不应重复弹窗'); });
        await continued.ensureOnlineAdminEntry();
        document.referrer = 'https://example.com/index.html';
        const returning = await compile(async () => { throw Error('同标签前后台切换不应重复弹窗'); });
        await returning.ensureOnlineAdminEntry();
        sessionStorage.removeItem(STUDIO_ENTRY_KEY);
        const groupOnly = await compile(async () => true);
        await assert.rejects(groupOnly.ensureOnlineAdminEntry(), error => error.cause === 'admin_entry_cancelled');
        assert.equal(sessionStorage.getItem(STUDIO_ENTRY_KEY), null);
        assert.ok(C.getSessionKeyRaw(group));
        assert.equal(C.getSessionKeyRaw(), null);
        """
        self.run_node_esm(body, preamble=(MOCK_SESSION_STORAGE, MOCK_DOM,
            mock_window('/admin-portal.html', hostname='example.com', is_admin=True)),
            node_args=('--experimental-vm-modules', '--no-warnings'))

    def test_groups_multiple_passwords_accumulate_and_lock_independently(self):
        """多密码分别成功或失败；第二组不会覆盖第一组，逐组锁回后其内容继续保密。"""
        body = """
        const c = await import('./data-manage/encrypt/crypto.module.js');
        const k = await import('./data-manage/encrypt/keyring.module.js');
        const {unlockPasswords} = await import('./data-manage/encrypt/group-unlock.module.js');
        const {revealInPlace} = await import('./data-manage/encrypt/secret-unlock.module.js');
        const a = await k.createKeyring('password-A','https://relay.example');
        const b = await k.createKeyring('password-B');
        const id = 'g_'+'a'.repeat(32);
        a.keyring.groups = {[id]: {...b.keyring,name:'分享组'}};
        const result = await unlockPasswords(['password-A','wrong','password-B'],a.keyring);
        assert.deepEqual(result,[['default'],[],[id]]);
        assert.equal(Object.keys(c.getSessionKeysRaw()).length,2);
        const ca = await c.wrapRecord({title:'A'},await c.getSessionKey());
        const cb = await c.wrapRecord({title:'B'},await c.getSessionKey(id),id);
        assert.equal(await c.decryptRecord(cb._enc,await c.getSessionKey()),null);
        const visible = [ca,cb];await revealInPlace(visible);
        assert.deepEqual(visible.map(x=>x.title),['A','B']);
        c.clearSessionKey('default');assert.ok(await c.getSessionKey(id));
        const partial = [ca,cb];await revealInPlace(partial);
        assert.ok(partial[0]._enc);assert.equal(partial[1].title,'B');
        globalThis.fetch = async()=>Response.json(a.keyring);
        const {getPrivateUrlBuilder} = await import('./data-manage/encrypt/private-media.module.js');
        assert.match((await getPrivateUrlBuilder(id))('photos/images/x/a.jpg'),new RegExp('&g='+id));
        c.clearSessionKey();assert.equal(Object.keys(c.getSessionKeysRaw()).length,0);
        """
        self.run_node_esm(body,preamble=(MOCK_SESSION_STORAGE,MOCK_DOM,mock_window('/index.html',hostname='example.com',is_admin=False)))


    def test_master_unlocks_connected_groups(self):
        """主密码只解锁自建组，逐组锁回保持独立，再输主密码可重新全解锁。"""
        body = """
        const c = await import('./data-manage/encrypt/crypto.module.js');
        const k = await import('./data-manage/encrypt/keyring.module.js');
        const { unlockPasswords } = await import('./data-manage/encrypt/group-unlock.module.js');
        const { revealInPlace } = await import('./data-manage/encrypt/secret-unlock.module.js');
        const primary = await k.createKeyring('master-password');
        primary.keyring.master_only = true;
        assert.deepEqual(k.passwordGroups(primary.keyring), []);
        const first = await k.createKeyring('first-password');
        const second = await k.createKeyring('second-password');
        const a = 'g_' + 'a'.repeat(32), b = 'g_' + 'b'.repeat(32);
        const master = await c.importDataKey(primary.dekRaw);
        primary.keyring.groups = {
            [a]: { ...first.keyring, name: '第一组', master_wrap: await k.wrapMasterGroup(a, first.keyring, first.dekRaw, master) },
            [b]: { ...second.keyring, name: '第二组', master_wrap: await k.wrapMasterGroup(b, second.keyring, second.dekRaw, master) }
        };
        const ring = primary.keyring;
        assert.equal(k.isValidKeyring(ring), true);
        assert.equal(k.isValidKeyring({ ...ring, groups: { [a]: { ...first.keyring, name: '未接入组' } } }), false);
        // 列表按名称拼音排列。解锁结果仍验证实际接入的密码组。
        assert.deepEqual(k.passwordGroups(ring).map(group => group.id), [b, a]);
        const records = await Promise.all([
            c.wrapRecord({ title: '第一组内容' }, await c.importDataKey(first.dekRaw), a),
            c.wrapRecord({ title: '第二组内容' }, await c.importDataKey(second.dekRaw), b)
        ]);
        assert.deepEqual(await unlockPasswords(['first-password'], ring), [[a]]);
        const partial = structuredClone(records);
        assert.equal(await revealInPlace(partial), 1);
        assert.equal(partial[0].title, '第一组内容');
        assert.ok(partial[1]._enc);
        c.clearSessionKey();
        assert.deepEqual(await unlockPasswords(['master-password'], ring), [['default', a, b]]);
        const all = structuredClone(records);
        assert.equal(await revealInPlace(all), 2);
        assert.equal(all[1].title, '第二组内容');
        c.clearSessionKey(a);
        assert.ok(await c.getSessionKey());
        assert.equal(await c.getSessionKey(a), null);
        const lockedBack = structuredClone(records);
        assert.equal(await revealInPlace(lockedBack), 1);
        assert.ok(lockedBack[0]._enc);
        assert.equal(lockedBack[1].title, '第二组内容');
        await unlockPasswords(['master-password'], ring);
        assert.ok(await c.getSessionKey(a));
        const rewrapped = await k.rewrapPassword(ring, primary.dekRaw, 'new-master-password');
        c.clearSessionKey();
        assert.deepEqual(await unlockPasswords(['new-master-password'], rewrapped), [['default', a, b]]);
        const damaged = { ...ring, groups: { ...ring.groups, [b]: { ...ring.groups[b], master_wrap: ring.groups[a].master_wrap } } };
        c.clearSessionKey();
        await assert.rejects(unlockPasswords(['master-password'], damaged), /第二组/);
        assert.deepEqual(c.getSessionKeysRaw(), {});
        """
        self.run_node_esm(body, preamble=(MOCK_SESSION_STORAGE, MOCK_DOM,
                                        mock_window('/index.html', hostname='example.com', is_admin=False)))


    def test_18_inline_media_manifest_and_private_reader_urls(self):
        """正文插图清单加密保存，解密阅读使用私有地址；缺图时阻止加锁。"""
        body = """
        const { randomBytes, setSessionKeyRaw, getSessionKey, unwrapRecord } = await import('./data-manage/encrypt/crypto.module.js');
        const { packCmsNodeForLock, collectCmsPrivateCoverKeys } = await import('./data-manage/encrypt/admin-lock.module.js');
        const { unpackRevealedNode } = await import('./data-manage/encrypt/private-media.module.js');
        setSessionKeyRaw(randomBytes(32));
        const row = { id:'img', path:'photos/images/_notes/a.png', thumb:'photos/thumbnails/_notes/a.webp', preview:'photos/previews/_notes/a.avif' };
        globalThis.fetch = async () => ({ok:true,json:async()=>({_notes:[row]})});
        const md = '![inline](../'+row.thumb+') <img src="https://images.example.com/'+row.path+'">';
        const packed = await packCmsNodeForLock({id:'n',type:'note',title:'私密',content:md});
        assert.deepEqual(packed.covers,[row.path]);
        const tree = await unwrapRecord({_enc:packed.enc},await getSessionKey());
        assert.deepEqual(tree.mediaRows.map(r=>r.path),[row.path]);
        assert.equal(tree.md,md);
        const revealed = unpackRevealedNode(tree,k=>'https://private.example/'+k+'?t=token');
        assert.ok(revealed.content.includes('https://private.example/'+row.thumb+'?t=token'));
        assert.ok(!revealed.content.includes('images.example.com'));
        assert.ok(!unpackRevealedNode(tree).content.includes('images.example.com'));
        assert.deepEqual((await collectCmsPrivateCoverKeys({_enc:packed.enc})).sort(),[row.path,row.thumb,row.preview].sort());
        await assert.rejects(packCmsNodeForLock({id:'missing',type:'note',content:'![x](photos/images/_notes/missing.png)'}),/正文图片/);
        """
        self.run_node_esm(body, preamble=(MOCK_SESSION_STORAGE, MOCK_DOM, mock_window('/admin-cms.html')))


    def test_02_webcrypto_aes_gcm_and_keyring_lifecycle(self):
        """AES-256-GCM 加解密、双层密钥环派生、改密不改 DEK、恢复码重置与错误口令拒绝"""
        body = """
        const {
            ENC_FIELD, importDataKey, wrapRecord, unwrapRecord, isEncryptedString, isEncryptedRecord,
            setSessionKeyRaw, getSessionKey, getSessionKeyRaw, clearSessionKey,
            getAccessToken, getAccessTokenHash
        } = await import('./data-manage/encrypt/crypto.module.js');
        const {
            isValidKeyring, createKeyring, unlockWithPassword, unlockWithRecovery,
            rewrapPassword, regenerateRecovery
        } = await import('./data-manage/encrypt/keyring.module.js');

        // 1. 创建双层密钥环并校验结构
        const { keyring, recoveryCode, dekRaw } = await createKeyring('MasterPass#2026', 'https://worker.example.com/');
        assert.equal(isValidKeyring(keyring), true);
        const publicRing = { v: keyring.v, dek_id: keyring.dek_id, pw: keyring.pw, media_base: keyring.media_base };
        assert.equal(isValidKeyring(publicRing), true);
        assert.deepEqual(await unlockWithPassword(publicRing, 'MasterPass#2026'), dekRaw);
        assert.equal(keyring.dek_id.length, 16);

        // 2. 主密码与（小写、空格分隔的）恢复码均解出同一 DEK，错误口令返回 null
        assert.deepEqual(await unlockWithPassword(keyring, 'MasterPass#2026'), dekRaw);
        assert.deepEqual(await unlockWithRecovery(keyring, recoveryCode.toLowerCase().replace(/-/g, ' ')), dekRaw);
        assert.equal(await unlockWithPassword(keyring, 'WrongPassword!'), null);
        assert.equal(await unlockWithRecovery(keyring, 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH'), null);

        // 3. 会话密钥存取与访问令牌派生（同一 DEK 派生结果稳定）
        setSessionKeyRaw(dekRaw);
        const sessionKey = await getSessionKey();
        assert.ok(sessionKey);
        assert.deepEqual(getSessionKeyRaw(), dekRaw);
        const token = await getAccessToken();
        assert.equal(token.length, 64);
        assert.equal((await getAccessTokenHash()).length, 64);
        assert.equal(await getAccessToken(), token);

        // 4. 记录级加密往返；两次加密同一明文必须产生不同密文（随机 IV）
        const sample = { id: 'n_1', title: '绝密设计稿', tags: ['E2EE', 'AES-GCM'], nested: { count: 42 } };
        const wrapped = await wrapRecord(sample, sessionKey);
        assert.equal(isEncryptedRecord(wrapped), true);
        assert.equal(isEncryptedString(wrapped[ENC_FIELD]), true);
        assert.ok(!wrapped[ENC_FIELD].includes('绝密'));
        assert.notEqual((await wrapRecord(sample, sessionKey))[ENC_FIELD], wrapped[ENC_FIELD]);
        assert.deepEqual(await unwrapRecord(wrapped, sessionKey), sample);

        // 5. 改密后 dek_id 不变、旧密码失效、旧密文仍可解
        const rotated = await rewrapPassword(keyring, dekRaw, 'NewMasterPass#9999');
        assert.equal(rotated.dek_id, keyring.dek_id);
        assert.equal(await unlockWithPassword(rotated, 'MasterPass#2026'), null);
        const byNewPw = await unlockWithPassword(rotated, 'NewMasterPass#9999');
        assert.deepEqual(byNewPw, dekRaw);
        assert.deepEqual(await unwrapRecord(wrapped, await importDataKey(byNewPw)), sample);

        // 6. 重新生成恢复码后旧码立即失效
        const { keyring: regen, recoveryCode: newRc } = await regenerateRecovery(rotated, dekRaw);
        assert.equal(await unlockWithRecovery(regen, recoveryCode), null);
        assert.deepEqual(await unlockWithRecovery(regen, newRc), dekRaw);

        clearSessionKey();
        assert.equal(await getSessionKey(), null);
        """
        self.run_node_esm(body, preamble=(MOCK_SESSION_STORAGE,))


    def test_03_cms_node_pack_unpack_and_lock_tree_state(self):
        """packCmsNodeForLock 打包 -> unpackRevealedNode 还原 -> extractLockedNodes / applyLockActionLocally 状态机"""
        fetch_mock = """
        globalThis.fetch = async (url) => {
            if (url === 'data/photos-data.json') {
                return { ok: true, json: async () => ({ _notes: [{
                    id: 'p_cov1', name: 'c1.avif',
                    path: 'photos/images/_notes/c1.avif',
                    thumb: 'photos/thumbnails/_notes/c1.webp',
                    preview: 'photos/previews/_notes/c1.avif'
                }] }) };
            }
            if (url === 'markdown/notes/child.md') {
                return { ok: true, text: async () => '# 子笔记正文\\n内容引用末尾.md' };
            }
            return { ok: false, status: 404 };
        };
        """
        body = """
        const { randomBytes, setSessionKeyRaw, getSessionKey, unwrapRecord } = await import('./data-manage/encrypt/crypto.module.js');
        const { packCmsNodeForLock, collectCmsPrivateCoverKeys } = await import('./data-manage/encrypt/admin-lock.module.js');
        const { unpackRevealedNode, extractLockedNodes, applyLockActionLocally } = await import('./data-manage/encrypt/private-media.module.js');

        setSessionKeyRaw(randomBytes(32));
        const key = await getSessionKey();

        // 1. 打包含封面、子笔记及已加密兄弟节点的文件夹
        const folderNode = {
            id: 'f_sec', type: 'folder', title: '私密目录', tags: ['归档'],
            coverImage: 'https://images.example.com/photos/images/_notes/c1.avif',
            children: [{ id: 'n_sub', type: 'note', title: '子笔记', tags: ['A'], content: 'markdown/notes/child.md', coverImage: null }]
        };
        const existingLocked = [{ id: 'n_already_locked', parentId: 'f_sec', index: 0, _enc: 'enc:iv0.ct0' }];
        const packed = await packCmsNodeForLock(folderNode, existingLocked);
        assert.ok(packed && packed.enc.startsWith('enc:'));
        assert.ok(!packed.enc.includes('私密目录'), '密文中不得出现明文标题');
        assert.deepEqual(packed.covers, ['photos/images/_notes/c1.avif']);

        // 2. 提取三尺寸私有桶 Key
        assert.deepEqual(await collectCmsPrivateCoverKeys({ id: 'f_sec', _enc: packed.enc }), [
            'photos/images/_notes/c1.avif',
            'photos/thumbnails/_notes/c1.webp',
            'photos/previews/_notes/c1.avif'
        ]);

        // 3. 解包并转换为私有桶签名 URL
        const tree = await unwrapRecord({ _enc: packed.enc }, key);
        const revealed = unpackRevealedNode(tree, (k) => `https://worker.dev/private/${k}?t=tok123`);
        assert.equal(revealed.coverImage, 'https://worker.dev/private/photos/images/_notes/c1.avif?t=tok123');
        assert.equal(revealed.coverThumb, 'https://worker.dev/private/photos/thumbnails/_notes/c1.webp?t=tok123');
        assert.equal(revealed.children.length, 2);
        assert.equal(revealed.children[0].id, 'n_already_locked');
        assert.equal(revealed.children[0]._enc, 'enc:iv0.ct0');
        // 以 .md 结尾的正文应追加换行，防止被误判为路径
        assert.equal(revealed.children[1].content, '# 子笔记正文\\n内容引用末尾.md\\n');

        // 4. 内存锁定状态机
        const state = {
            root: [{ id: 'n_pub', type: 'note', title: '公开' }, { id: 'n_lock1', type: 'locked', _enc: 'enc:iv1.ct1' }],
            lockedNodes: [], allNodes: []
        };
        const flatten = (list) => list.forEach(n => { state.allNodes.push(n); if (n.children) flatten(n.children); });
        extractLockedNodes(state.root, state.lockedNodes);
        assert.equal(state.root.length, 1);
        assert.deepEqual(state.lockedNodes.map(n => [n.id, n.index]), [['n_lock1', 1]]);

        applyLockActionLocally(state, flatten, 'lock', { id: 'n_pub', enc: 'enc:iv_pub.ct_pub' });
        assert.equal(state.root.length, 0);
        assert.equal(state.lockedNodes.length, 2);

        applyLockActionLocally(state, flatten, 'unlock', {
            id: 'n_pub', tree: { id: 'n_pub', type: 'note', title: '公开还原', md: '还原正文' }
        });
        assert.equal(state.root.length, 1);
        assert.equal(state.root[0].title, '公开还原');
        assert.equal(state.root[0]._draftContent, '还原正文');
        assert.equal(state.root[0]._pendingRelay, true);

        applyLockActionLocally(state, flatten, 'delete', { id: 'n_lock1' });
        assert.equal(state.lockedNodes.length, 0);
        """
        self.run_node_esm(body, preamble=(
            MOCK_SESSION_STORAGE, MOCK_DOM, mock_window('/admin-cms.html', is_admin=True), fetch_mock,
        ))


    def test_04_secret_unlock_reveal_in_place_and_page_guard(self):
        """lockIndexCardRecord 生成 _guard；revealInPlace 访客态递归还原、管理态严格跳过"""
        body = """
        const { randomBytes, setSessionKeyRaw, getSessionKey, wrapRecord } = await import('./data-manage/encrypt/crypto.module.js');
        const { lockIndexCardRecord } = await import('./data-manage/encrypt/admin-lock.module.js');
        const { revealInPlace, pageGuardHash } = await import('./data-manage/encrypt/secret-unlock.module.js');

        setSessionKeyRaw(randomBytes(32));
        const key = await getSessionKey();

        // 1. 首页卡片加锁生成页面守卫哈希
        const lockedCard = await lockIndexCardRecord({ id: 'card_lit', title: '文学', url: 'literature.html' });
        assert.ok(lockedCard._enc);
        assert.equal(lockedCard._guard, await pageGuardHash('literature.html'));

        // 2. 管理态不得原地解密（防止明文被误保存回仓库）
        globalThis.window.IS_ADMIN = true;
        const adminList = [{ ...lockedCard }];
        assert.equal(await revealInPlace(adminList), 0);
        assert.ok(adminList[0]._enc);

        // 3. 访客态递归还原父子密文
        globalThis.window.IS_ADMIN = false;
        const encChild = await wrapRecord({ id: 'c_1', title: '子项' }, key);
        const visitorList = [await wrapRecord({ id: 'p_1', title: '父项', children: [encChild] }, key)];
        assert.equal(await revealInPlace(visitorList, { getChildren: (r) => r.children }), 2);
        assert.equal(visitorList[0].title, '父项');
        assert.equal(visitorList[0].children[0].title, '子项');
        """
        self.run_node_esm(body, preamble=(MOCK_SESSION_STORAGE, mock_window('/index.html', is_admin=False)))


    def test_10_lock_pack_preserves_nested_ciphertext_and_inline_markdown(self):
        """嵌套密文与内联正文不丢失，封面索引读取失败会阻止迁移"""
        body = """
        const { setSessionKeyRaw, getSessionKey, unwrapRecord } = await import('./data-manage/encrypt/crypto.module.js');
        const { packCmsNodeForLock } = await import('./data-manage/encrypt/admin-lock.module.js');
        setSessionKeyRaw(crypto.getRandomValues(new Uint8Array(32)));
        const node = { id: 'folder', type: 'folder', children: [
            { id: 'locked', _enc: 'enc:keep-ciphertext' },
            { id: 'inline', type: 'note', content: '# Inline', title: '内联' }
        ] };
        globalThis.fetch = async () => { throw Error('offline'); };
        const packed = await packCmsNodeForLock(node);
        const result = await unwrapRecord({ _enc: packed.enc }, await getSessionKey());
        assert.equal(result.children[0]._enc, 'enc:keep-ciphertext');
        assert.equal(result.children[1].md, '# Inline');
        await assert.rejects(packCmsNodeForLock({ id: 'cover', type: 'note', content: '# test',
            coverImage: 'photos/images/_notes/secret.avif' }), /封面索引/);
        """
        self.run_node_esm(body, preamble=(MOCK_SESSION_STORAGE, MOCK_LOCAL_STORAGE, MOCK_DOM, mock_window('/admin-cms.html')))


    def test_25_nested_rotation_changes_data_key_and_preserves_all_plaintext(self):
        """轮换包含嵌套密文；旧 DEK 无法读取新密文，损坏记录阻断整批迁移。"""
        body = """
        const C = await import('./data-manage/encrypt/crypto.module.js');
        const {rotateSnapshots} = await import('./data-manage/encrypt/key-rotation.module.js');
        const oldKey = await C.importDataKey(C.randomBytes(32)), newKey = await C.importDataKey(C.randomBytes(32));
        const child = await C.wrapRecord({title:'private child',md:'body'},oldKey);
        const parent = await C.wrapRecord({title:'private folder',children:[child]},oldKey);
        const input = [{path:'notes-tree.json',revision:'unchanged',data:{root:[{id:'n',...parent}],public:'keep'}}];
        const output = await rotateSnapshots(input,oldKey,newKey);
        assert.equal(output[0].data.public,'keep');
        assert.equal(input[0].data.root[0]._enc,parent._enc);
        assert.equal(await C.unwrapRecord(output[0].data.root[0],oldKey),null);
        const plain = await C.unwrapRecord(output[0].data.root[0],newKey);
        assert.equal(plain.title,'private folder');
        assert.deepEqual(await C.unwrapRecord(plain.children[0],newKey),{title:'private child',md:'body'});
        await assert.rejects(rotateSnapshots([{data:{_enc:'enc:broken'}}],oldKey,newKey));
        """
        self.run_node_esm(body, preamble=(MOCK_DOM,))


    def test_26_private_titles_do_not_enter_persistent_history(self):
        """访客解密节点传播私密标记，历史只记录公开文章。"""
        body = """
        const C = await import('./data-manage/encrypt/crypto.module.js');
        const {revealInPlace} = await import('./data-manage/encrypt/secret-unlock.module.js');
        const {addToHistory} = await import('./custom/cms/viewer/cms-recent.module.js');
        C.setSessionKeyRaw(C.randomBytes(32));
        const key = await C.getSessionKey();
        const records = [await C.wrapRecord({id:'private',type:'note',title:'PRIVATE TITLE'},key)];
        await revealInPlace(records);
        assert.equal(records[0]._private,true);
        addToHistory(records[0]);
        addToHistory({id:'public',type:'note',title:'PUBLIC TITLE'});
        C.clearSessionKey();
        const history = localStorage.getItem('maers_cms_recent_files_default');
        assert.ok(history.includes('PUBLIC TITLE'));
        assert.ok(!history.includes('PRIVATE TITLE'));
        """
        self.run_node_esm(body, preamble=(MOCK_SESSION_STORAGE, MOCK_LOCAL_STORAGE, MOCK_DOM,
                                        mock_window('/notes.html', hostname='example.com', is_admin=False)))


    def test_27_media_entry_can_switch_to_other_host_or_same_site(self):
        """切换图片入口不修改文件键；私密带令牌 URL 不会被公开入口改写。"""
        body = """
        const {publicMediaUrl} = await import('./data-manage/data-provider.module.js');
        const {markdownUrl} = await import('./shared/content-url.module.js');
        window.MAERS = {Config:{MEDIA_PUBLIC_BASE:'https://other.example/assets'}};
        assert.throws(() => markdownUrl('markdown/notes/article.md', {local:false}), /公开正文地址不能为空/);
        window.MAERS.Config.CONTENT_PUBLIC_BASE = 'https://docs.example/';
        assert.equal(markdownUrl('markdown/notes/a b.md', {local:false}), 'https://docs.example/markdown/notes/a%20b.md');
        assert.equal(markdownUrl('markdown/notes/a b.md'), 'markdown/notes/a%20b.md');
        const key = 'photos/images/travel/图片 #1.png';
        assert.equal(publicMediaUrl(key),'https://other.example/assets/photos/images/travel/%E5%9B%BE%E7%89%87%20%231.png');
        for (const size of ['thumbnails', 'previews']) {
            const derivative = `photos/${size}/travel/图片 #1.webp`;
            assert.equal(publicMediaUrl(derivative),`https://other.example/assets/photos/${size}/travel/%E5%9B%BE%E7%89%87%20%231.webp`);
        }
        const privateUrl = 'https://private.example/private/a?t=secret';
        assert.equal(publicMediaUrl(privateUrl),privateUrl);
        window.MAERS.Config.MEDIA_PUBLIC_BASE = '';
        assert.equal(publicMediaUrl(key),'photos/images/travel/%E5%9B%BE%E7%89%87%20%231.png');
        const C = await import('./data-manage/encrypt/crypto.module.js');
        C.setSessionKeyRaw(C.randomBytes(32));
        const row = {path:key,thumb:'thumb.webp',preview:'preview.avif'};
        globalThis.fetch = async () => ({ok:true,json:async()=>({travel:[row]})});
        const {DataProvider} = await import('./data-manage/data-provider.module.js');
        await DataProvider.loadCoverIndex();
        const cover = 'https://other.example/assets/' + key.split('/').map(encodeURIComponent).join('/');
        assert.equal(DataProvider.getCoverUrl({coverImage:cover},'thumb'),row.thumb);
        const {packCmsNodeForLock} = await import('./data-manage/encrypt/admin-lock.module.js');
        const packed = await packCmsNodeForLock({id:'n',type:'note',title:'test',content:'body',coverImage:cover});
        assert.deepEqual(packed.covers,[key]);
        """
        self.run_node_esm(body,preamble=(MOCK_SESSION_STORAGE,MOCK_DOM,mock_window('/admin-cms.html',is_admin=True)))

