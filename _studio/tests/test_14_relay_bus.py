# -*- coding: utf-8 -*-
"""中继总线回归：动作注册表、回放、冲突检测、保存反馈真实性，以及后端回执入口。"""

import os

from .node_runtime import MOCK_DOM, MOCK_KV, MOCK_LOCAL_STORAGE, MOCK_SESSION_STORAGE, NodeTestCase, mock_window
from .sandbox import SandboxTestCase, photos
from services import storage

PREAMBLE = (MOCK_LOCAL_STORAGE, MOCK_DOM, mock_window('/admin-cms.html', hostname='example.com', is_admin=True))


class Test14_RelayBusRuntime(NodeTestCase):
    """前端注册表与回放逻辑（纯函数，无网络）"""

    def test_failure_choice_buttons_and_close_settle_once(self):
        """无浏览器验证：两项选择、关闭及 Escape 返回正确结果，动态错误文本转义。"""
        body = """
        const {AdminModal}=await import('./data-manage/admin/admin-modal.module.js');
        const listeners=new Map();let modal;
        document.getElementById=()=>({});
        document.addEventListener=(name,handler)=>listeners.set(name,handler);
        document.removeEventListener=(name,handler)=>{if(listeners.get(name)===handler)listeners.delete(name);};
        document.querySelectorAll=()=>[modal];
        globalThis.CSS={supports:()=>false};globalThis.requestAnimationFrame=callback=>callback();
        document.createElement=tag=>{
            if(tag==='button')return __mockEl();
            const controls=new Map(['.mlock-box','.mlock-hint','[data-act="ok"]','[data-act="close"]',
                '[data-act="alternate"]'].map(selector=>[selector,{...__mockEl(),focus(){},disabled:false,textContent:'操作'}]));
            controls.set('.mlock-footer',{children:[],appendChild(button){this.children.push(button);}});
            return {...__mockEl(),controls,querySelector:selector=>controls.get(selector)||null,
                querySelectorAll:()=>[],remove(){this.removed=true;}};
        };
        document.body.appendChild=element=>{modal=element;};
        for(const action of ['skip','retry','delete','overwrite','close','escape']) {
            const pending=AdminModal.choose({title:'拉取失败，请选择处理方式',message:'<script>错误</script>',
                primary:{text:'从失败项开始重新拉取',value:'retry'},secondary:{text:'跳过失败项继续拉取',value:'skip'},
                extraChoices:[{text:'删除这条草稿并继续',value:'delete'},{text:'备份并用云端草稿覆盖',value:'overwrite'}]});
            assert.match(modal.innerHTML,/&lt;script&gt;错误&lt;[/]script&gt;/);
            assert.ok(!modal.innerHTML.includes('<script>'));
            assert.match(modal.innerHTML,/aria-label="关闭弹窗"/);
            if(action==='escape')listeners.get('keydown')({key:'Escape',preventDefault(){},stopPropagation(){}});
            else if(action==='delete'||action==='overwrite')modal.controls.get('.mlock-footer').children[action==='delete'?0:1].onclick();
            else await modal.controls.get('[data-act="'+(action==='skip'?'alternate':action==='retry'?'ok':'close')+'"]').onclick();
            assert.equal(await pending,['close','escape'].includes(action)?null:action);
            assert.equal(modal.removed,true);assert.equal(listeners.size,0);
            await modal.controls.get('[data-act="ok"]').onclick();
            assert.equal(listeners.size,0,'关闭后的迟到点击不能重新开启选择');
        }
        """
        self.run_node_esm(body, preamble=PREAMBLE)

    def test_markdown_conflict_overwrite_and_delete_failed_draft(self):
        """覆盖携带确认版本；单次点击删除当前键，关闭或删除失败保留草稿。"""
        body = """
        const {mergeRelayQueue}=await import('./data-manage/sync/sync-queue.module.js');
        const {AdminModal}=await import('./data-manage/admin/admin-modal.module.js');
        const {Toast}=await import('./shared/toast.module.js');
        for(const method of ['info','success','warning','error'])Toast[method]=()=>{};
        const revision='a'.repeat(64);
        const items=[{key:'bad',data:{module:'notes',action:'update',timestamp:1,
            data:{id:'n',data:{title:'正文',content:'手机正文',expectedRevision:'b'.repeat(64)}}}},
            {key:'good',data:{module:'photos',action:'upload',timestamp:2,data:{category:'travel',name:'ok.jpg'}}}];
        for(const mode of ['overwrite','delete','close','delete-error']) {
            const calls=[],acks=[];let prompts=0,confirmed=0;
            const manager={config:{relay:{endpoint:'https://relay.example',secret:'s'}},_appliedRelayKeys:new Map(),
                localPendingSessionItems:items.map(item=>item.data),updateButtonBadge(){},
                Controller:{loadData:async()=>true,refreshView:async()=>{}}};
            globalThis.fetch=async(url,options={})=>{
                if(String(url).startsWith('data/'))return Response.json({root:[{id:'n'}]});
                const key=new URL(url,window.location.href).searchParams.get('_relay_key');
                const body=JSON.parse(options.body);calls.push([key,body]);
                return key==='bad'&&!body._overwriteRevision
                    ?Response.json({code:'markdown_conflict',currentRevision:revision,error:'正文已变化'},{status:409})
                    :Response.json({success:true});
            };
            AdminModal.choose=async options=>{
                assert.equal(options.title,'拉取失败，请选择处理方式');
                assert.ok(options.extraChoices.some(item=>item.value==='delete'));
                assert.equal(options.extraChoices.find(item=>item.value==='delete').text,'删除这条草稿并继续');
                assert.ok(options.extraChoices.some(item=>item.value==='overwrite'));
                return ++prompts>1||mode==='close'?null:mode==='overwrite'?'overwrite':'delete';
            };
            const driver={pull:async()=>({success:true,items}),ack:async(e,s,keys)=>{
                acks.push(keys);return {success:mode!=='delete-error'};
            }};
            const complete=await mergeRelayQueue(manager,driver,{onAcknowledged:()=>confirmed++});
            assert.equal(complete,['overwrite','delete'].includes(mode));
            if(mode==='overwrite') {
                assert.deepEqual(calls.map(item=>item[0]),['bad','bad','good']);
                assert.equal(calls[1][1]._overwriteRevision,revision);
                assert.equal(calls[1][1].data.expectedRevision,'b'.repeat(64));
                assert.deepEqual(acks,[['bad','good']]);
            } else if(mode==='delete') {
                assert.deepEqual(calls.map(item=>item[0]),['bad','good']);
                assert.deepEqual(acks,[['bad'],['good']]);
            } else {
                assert.equal(calls.length,1);assert.equal(manager.pendingItemsCount,2);
                assert.deepEqual(acks,mode==='close'?[]:[['bad']]);
            }
            assert.equal(prompts,mode==='delete-error'?2:1,'删除不得再打开二次弹窗');
            assert.equal(confirmed,complete?1:0);
            assert.equal(manager.localPendingSessionItems.length,complete?0:2);
        }
        """
        self.run_node_esm(body, preamble=PREAMBLE)

    def test_merge_failure_dialog_skip_retry_and_close(self):
        """跳过、原地重试、关闭分别保留正确草稿，确认框等待期间不写入后续项目。"""
        body = """
        const {mergeRelayQueue}=await import('./data-manage/sync/sync-queue.module.js');
        const {AdminModal}=await import('./data-manage/admin/admin-modal.module.js');
        const {Toast}=await import('./shared/toast.module.js');
        for(const method of ['info','success','warning','error'])Toast[method]=()=>{};
        const items=[1,2,3].map(number=>({key:'key'+number,data:{module:'photos',action:'upload',timestamp:number,
            data:{category:'travel',name:number+'.jpg',path:'photos/images/travel/'+number+'.jpg'}}}));
        for(const choice of ['skip','retry',null]) {
            const calls=[],acked=[];let prompts=0;
            const manager={config:{relay:{endpoint:'https://relay.example',secret:'s'}},_appliedRelayKeys:new Map(),
                localPendingSessionItems:items.map(item=>item.data),updateButtonBadge(){},
                Controller:{loadData:async()=>true,refreshView:async()=>{}}};
            globalThis.fetch=async(url,options={})=>{
                const key=new URL(url,window.location.href).searchParams.get('_relay_key');calls.push(key);
                if(key==='key2'&&calls.filter(value=>value===key).length===1)return Response.json({error:'下载失败'},{status:400});
                return Response.json({success:true});
            };
            AdminModal.choose=async options=>{
                prompts++;
                assert.equal(options.title,'拉取失败，请选择处理方式');
                assert.deepEqual(options.primary,{text:'从失败项开始重新拉取',value:'retry'});
                assert.deepEqual(options.secondary,{text:'跳过失败项继续拉取',value:'skip'});
                assert.match(options.message,/可能改变数据顺序，不会损坏数据/);
                assert.deepEqual(calls,['key1','key2']);await Promise.resolve();
                assert.deepEqual(calls,['key1','key2'],'等待用户选择时不处理后续草稿');
                return choice;
            };
            const driver={pull:async()=>({success:true,items}),ack:async(e,s,keys)=>{acked.push(...keys);return {success:true};}};
            assert.equal(await mergeRelayQueue(manager,driver),choice==='retry');
            assert.equal(prompts,1);
            assert.deepEqual(calls,choice==='retry'?['key1','key2','key2','key3']:choice==='skip'?['key1','key2','key3']:['key1','key2']);
            assert.deepEqual(acked,choice==='retry'?['key1','key2','key3']:choice==='skip'?['key1','key3']:['key1']);
            const remaining=choice==='retry'?[]:choice==='skip'?[items[1].data]:items.slice(1).map(item=>item.data);
            assert.deepEqual(manager.localPendingSessionItems,remaining);
            assert.equal(manager.pendingItemsCount,remaining.length);
        }
        """
        self.run_node_esm(body, preamble=PREAMBLE)

    def test_merge_retry_last_item_and_cloud_confirmation(self):
        """最后一项可重试，云端确认失败后再次合并不重复本地写入。"""
        body = """
        const {mergeRelayQueue}=await import('./data-manage/sync/sync-queue.module.js');
        const {Toast}=await import('./shared/toast.module.js');
        for(const method of ['info','success','warning','error'])Toast[method]=()=>{};
        const items=[1,2,3].map(number=>({key:'key'+number,data:{module:'photos',action:'upload',timestamp:number,
            data:{category:'travel',name:number+'.jpg',path:'photos/images/travel/'+number+'.jpg'}}}));
        const calls=[],acks=[],choices=['skip','retry'];let prompted=0;
        const manager={config:{relay:{endpoint:'https://relay.example',secret:'s'}},_appliedRelayKeys:new Map(),
            localPendingSessionItems:items.map(item=>item.data),updateButtonBadge(){},
            Controller:{loadData:async()=>true,refreshView:async()=>{}}};
        globalThis.fetch=async url=>{
            const key=new URL(url,window.location.href).searchParams.get('_relay_key');calls.push(key);
            if(key==='key2'||(key==='key3'&&calls.filter(value=>value===key).length===1))return Response.json({error:'下载失败'},{status:400});
            return Response.json({success:true});
        };
        const driver={pull:async()=>({success:true,items}),ack:async(e,s,keys)=>{acks.push(keys);return {success:acks.length>1};}};
        assert.equal(await mergeRelayQueue(manager,driver,{chooseFailure:async()=>choices[prompted++]}),false);
        assert.deepEqual(calls,['key1','key2','key3','key3']);
        assert.equal(prompted,2);assert.equal(manager.pendingItemsCount,3);
        assert.equal(manager._appliedRelayKeys.size,2);
        assert.equal(await mergeRelayQueue(manager,driver,{chooseFailure:async()=>'skip'}),false);
        assert.deepEqual(calls,['key1','key2','key3','key3','key2']);
        assert.deepEqual(acks,[['key1','key3'],['key1','key3']]);
        assert.deepEqual(manager.localPendingSessionItems,[items[1].data]);
        assert.equal(manager._appliedRelayKeys.size,0);assert.equal(manager.pendingItemsCount,1);
        """
        self.run_node_esm(body, preamble=PREAMBLE)

    def test_merge_skip_keeps_markdown_dependencies_and_shared_attachments(self):
        """失败 MD、后续同文编辑和父目录删除保留，其他文章与图片继续；共享附件不误清理。"""
        body = """
        const {mergeRelayQueue}=await import('./data-manage/sync/sync-queue.module.js');
        const {Toast}=await import('./shared/toast.module.js');
        for(const method of ['info','success','warning','error'])Toast[method]=()=>{};
        const shared='photos/images/_notes/shared.png',other='photos/images/_notes/other.png';
        const row=(key,module,action,data)=>({key,data:{module,action,data,timestamp:0}});
        const items=[
            row('failed','notes','update',{id:'a',data:{content:'旧草稿 ![]('+shared+')'}}),
            row('later','notes','update',{id:'a',data:{content:'新草稿'}}),
            row('other','notes','update',{id:'b',data:{content:'![]('+shared+') ![]('+other+')'}}),
            row('parent','notes','delete',{id:'folder'}),
            row('photo','photos','upload',{category:'travel',name:'p.jpg',path:'photos/images/travel/p.jpg'}),
            row('music','doc','replace',{doc:'music',content:[]}),
            row('same-id','record','update',{id:'a',data:{content:'其他模块'}})
        ];items.forEach((item,index)=>item.data.timestamp=index+1);
        const calls=[],ack=[],media=[],cleared=[];let prompts=0;
        globalThis.fetch=async(url,options={})=>{
            if(url==='data/notes-tree.json')return Response.json({root:[{id:'folder',children:[{id:'a'},{id:'b'}]}]});
            const key=new URL(url,window.location.href).searchParams.get('_relay_key');calls.push(key);
            if(key==='failed')return Response.json({error:'缺少附件'},{status:400});
            return Response.json({success:true,_draft_media:key==='other'?[shared,other]:[]});
        };
        const manager={config:{relay:{endpoint:'https://relay.example',secret:'s'}},_appliedRelayKeys:new Map(),
            localPendingSessionItems:items.map(item=>item.data),updateButtonBadge(){},
            Controller:{loadData:async()=>true,refreshView:async()=>{}}};
        const driver={pull:async()=>({success:true,items}),ack:async(e,s,keys,paths)=>{ack.push(...keys);media.push(...paths);return {success:true};}};
        assert.equal(await mergeRelayQueue(manager,driver,{chooseFailure:async()=>{prompts++;return 'skip';},
            onAcknowledged:paths=>cleared.push(...paths)}),false);
        assert.deepEqual(calls,['failed','other','photo','music','same-id']);assert.equal(prompts,1);
        assert.deepEqual(ack,['other','photo','music','same-id']);
        assert.deepEqual(media,[other]);assert.deepEqual(cleared,[other]);
        assert.deepEqual(manager.localPendingSessionItems,[items[0].data,items[1].data,items[3].data]);
        assert.equal(manager.pendingItemsCount,3);
        """
        self.run_node_esm(body, preamble=PREAMBLE)

    def test_merge_retry_rechecks_snapshot_and_initial_pull(self):
        """原地重试不能绕过快照基线，列表拉取失败也能重试或关闭。"""
        body = """
        const {mergeRelayQueue}=await import('./data-manage/sync/sync-queue.module.js');
        const {contentHash}=await import('./data-manage/sync/relay-actions.module.js');
        const {Toast}=await import('./shared/toast.module.js');
        for(const method of ['info','success','warning','error'])Toast[method]=()=>{};
        const make=()=>({config:{relay:{endpoint:'https://relay.example',secret:'s'}},_appliedRelayKeys:new Map(),
            localPendingSessionItems:[],updateButtonBadge(){},Controller:{loadData:async()=>true,refreshView:async()=>{}}});
        const base=[{name:'base'}];let current=base,reads=0,saves=0,prompts=0,conflicts=0;
        const item={key:'music',data:{module:'doc',action:'replace',timestamp:1,
            data:{doc:'music',content:[{name:'phone'}],baseHash:await contentHash(base)}}};
        globalThis.fetch=async(url,options={})=>{
            if(url==='data/music-data.json'){reads++;return Response.json(current);}
            saves++;return Response.json({error:'保存失败'},{status:500});
        };
        const driver={pull:async()=>({success:true,items:[item]}),ack:()=>assert.fail('失败草稿不能确认')};
        assert.equal(await mergeRelayQueue(make(),driver,{
            chooseFailure:async()=>{prompts++;current=[{name:'desktop changed'}];return prompts===1?'retry':null;},
            confirmOverwrite:()=>{conflicts++;return false;}}),false);
        assert.equal(reads,2);assert.equal(saves,1);assert.equal(conflicts,1);assert.equal(prompts,2);
        for(const choice of ['retry','skip',null]) {
            let pulls=0,asked=0;
            const reader={pull:async()=>++pulls===1?{success:false,msg:'offline'}:{success:true,items:[]}};
            assert.equal(await mergeRelayQueue(make(),reader,{chooseFailure:async message=>{
                asked++;assert.match(message,/尚未取得草稿列表/);return choice;}}),choice==='retry');
            assert.equal(pulls,choice==='retry'?2:1);assert.equal(asked,1);
        }
        """
        self.run_node_esm(body, preamble=PREAMBLE)

    def test_merge_dependency_guard_keeps_old_parent_and_transitive_changes(self):
        """失败移动保留真实父目录，失败新目录的依赖逐级传递，未知目录和密文保守保留。"""
        body = """
        const {RelayDependencies}=await import('./data-manage/sync/sync-dependencies.module.js');
        const draft=(action,data,module='notes')=>({module,action,data});
        const tree={root:[{id:'old',children:[{id:'moving',children:[{id:'child'}]},{id:'sibling'}]},{id:'target',children:[]}]};
        globalThis.fetch=async()=>Response.json(tree);
        const guard=new RelayDependencies();
        await guard.hold(draft('move',{id:'moving',targetParentId:'target'}));
        for(const id of ['old','target','moving','child'])assert.equal(guard.isBlocked(draft('delete',{id})),true,id);
        assert.equal(guard.isBlocked(draft('update',{id:'sibling',data:{content:'独立文章'}})),false);
        assert.equal(guard.isBlocked(draft('update',{id:'child'},'record')),false);
        await guard.hold(draft('add',{id:'new-folder',parentId:'root',type:'folder',title:'新目录'}));
        const child=draft('add',{id:'new-child',parentId:'new-folder',type:'note',title:'新文章'});
        assert.equal(guard.isBlocked(child),true);await guard.hold(child);
        assert.equal(guard.isBlocked(draft('update',{id:'new-child',data:{content:'后续编辑'}})),true);
        const unknown=new RelayDependencies();globalThis.fetch=async()=>Response.json({}, {status:500});
        await unknown.hold(draft('update',{id:'a'}));
        assert.equal(unknown.isBlocked(draft('update',{id:'b'})),true);
        assert.equal(unknown.isBlocked(draft('update',{id:'b'},'record')),false);
        const paths=new Set(['photos/images/travel/a.png']);
        assert.deepEqual(guard.mediaToAcknowledge(paths,[{data:{module:'private',data:{enc:'密文'}}}]),[]);
        assert.deepEqual(guard.mediaToAcknowledge(paths,[{data:{module:'notes',data:{tree:{children:[{_enc:'密文'}]}}}}]),[]);
        assert.deepEqual(guard.mediaToAcknowledge(paths,[{data:{module:'notes',data:{content:'`photos/images/travel/a.png`'}}}]),[]);
        assert.doesNotThrow(()=>guard.isBlocked({module:'doc',data:{doc:1}}));
        """
        self.run_node_esm(body, preamble=PREAMBLE)

    def test_retired_upload_is_archived_before_ack_and_never_registered(self):
        body = """
        const {mergeRelayQueue}=await import('./data-manage/sync/sync-queue.module.js');
        const {replayPhotos}=await import('./data-manage/sync/relay-actions.module.js');
        const item={key:'sync_request_12345678-1234-4234-8234-123456789abc',data:{
            module:'photos',action:'upload',awaitingPhoto:true,timestamp:1,
            data:{category:'travel',path:'photos/images/travel/old.jpg',name:'old.jpg'}}};
        assert.deepEqual(replayPhotos('travel',[],[item.data]),[]);
        const manager=()=>({config:{relay:{endpoint:'https://relay.example',secret:'test'}},
            _appliedRelayKeys:new Map(),localPendingSessionItems:[item.data],updateButtonBadge(){}});
        globalThis.window.location.reload=()=>{};
        for(const backupOk of [true,false]) {
            const calls=[];let acked=false;
            globalThis.fetch=async(url,options={})=>{
                if(String(url).endsWith('/api/session'))return {ok:true,json:async()=>({token:'test-session'})};
                assert.equal(new URL(url,'http://localhost:8000').pathname,'/api/relay/archive-upload');
                assert.deepEqual(JSON.parse(options.body),{source:'https://relay.example',item:{...item,timestamp:1}});
                calls.push('backup');return {ok:backupOk,status:backupOk?200:500,
                    json:async()=>backupOk?{archived:true}:{error:'disk full'}};
            };
            const m=manager(),driver={pull:async()=>({success:true,items:[item]}),
                ack:async(endpoint,secret,keys,media)=>{
                    assert.deepEqual(calls,['backup']);assert.deepEqual(keys,[item.key]);
                    assert.deepEqual(media,[]);acked=true;return {success:true};}};
            assert.equal(await mergeRelayQueue(m,driver,{chooseFailure:async()=>null}),backupOk);
            assert.equal(acked,backupOk);
            assert.equal(m.pendingItemsCount,backupOk?0:1);
        }
        """
        self.run_node_esm(body, preamble=PREAMBLE)

    def test_cms_sibling_names_and_flat_filename_preview(self):
        """新建、改名和移动统一拒绝同级重名，跨目录同名并使用完整目录前缀。"""
        body = """
        const { applyCmsNodeAction, validateCmsNodeAction } = await import('./data-manage/sync/relay-actions.module.js');
        const root = [{id:'a',type:'folder',title:'Linux',children:[
            {id:'shell',type:'folder',title:'Shell',children:[{id:'n',type:'note',title:'命令'}]}
        ]},{id:'b',type:'folder',title:'Windows',children:[{id:'other',type:'note',title:'命令'}]}];
        const add = (id, parentId, title, type='note') => ({id, parentId, title, type});
        for (const type of ['note', 'folder']) {
            assert.throws(() => applyCmsNodeAction('notes', root, 'add', add('bad', 'shell', ' 命令 ', type)), /同名/);
        }
        assert.throws(() => validateCmsNodeAction(root,'update',{id:'a',data:{title:'Windows'}}), /同名/);
        assert.throws(() => validateCmsNodeAction(root,'move',{id:'n',targetParentId:'b'}), /同名/);
        applyCmsNodeAction('notes', root, 'add', add('good', 'a', '命令'));
        assert.equal(root[0].children[0].content, 'markdown/notes/Linux-命令.md');
        applyCmsNodeAction('notes', root, 'add', add('nested', 'shell', '脚本'));
        assert.equal(root[0].children[1].children[0].content, 'markdown/notes/Linux-Shell-脚本.md');
        applyCmsNodeAction('notes', root, 'add', add('top', 'root', '随记'));
        assert.equal(root[0].content, 'markdown/notes/root-随记.md');
        validateCmsNodeAction(root,'update',{id:'n',data:{title:'命令'}});
        validateCmsNodeAction(root,'move',{id:'n',targetParentId:'shell'});
        """
        self.run_node_esm(body, preamble=PREAMBLE)

    def test_01_cms_move_and_reorder_replay_after_refresh(self):
        """刷新后 move / reorder 必须按草稿回放（此前回放丢失）。"""
        body = """
        const { replayQueuedDrafts } = await import('./data-manage/sync/sync-queue.module.js');
        const state = () => ({root:[{id:'a',type:'note',title:'A',tags:[]},{id:'b',type:'note',title:'B',tags:[]},
            {id:'f',type:'folder',title:'F',children:[]}],allNodes:[],lockedNodes:[]});
        const draft = (action, data, timestamp) => ({module:'notes',action,data,timestamp});
        let s = state();
        replayQueuedDrafts('notes', s, [draft('reorder',{ids:['b','a','f']},1)]);
        assert.deepEqual(s.root.map(n => n.id), ['b','a','f']);
        s = state();
        replayQueuedDrafts('notes', s, [draft('move',{id:'a',targetParentId:'f'},1)]);
        assert.deepEqual(s.root.map(n => n.id), ['b','f']);
        assert.deepEqual(s.root[1].children.map(n => n.id), ['a']);
        assert.equal(s.allNodes.find(n => n.id === 'a').parentId, 'f');
        s = state();
        replayQueuedDrafts('notes', s, [draft('move',{id:'f',targetParentId:'f'},1)]);
        assert.deepEqual(s.root.map(n => n.id), ['a','b','f']);
        """
        self.run_node_esm(body, preamble=PREAMBLE)

    def test_cms_delete_replay_keeps_protected_records(self):
        """旧删除草稿不能在回放时隐藏密文卡片或包含密文的文件夹。"""
        body = """
        const { replayQueuedDrafts } = await import('./data-manage/sync/sync-queue.module.js');
        const inner = {id:'inner', type:'folder', children:[]};
        const outer = {id:'outer', type:'folder', children:[inner]};
        const unlocked = {id:'unlocked', type:'note', _cloudEnvelope:true, _private:true};
        const publicNode = {id:'public', type:'note'};
        const state = {root:[outer, unlocked, publicNode], allNodes:[outer, inner, unlocked, publicNode],
            lockedNodes:[{id:'locked', parentId:'inner'}]};
        const drafts = ['locked', 'outer', 'unlocked', 'public'].map((id, timestamp) => (
            {module:'notes', action:'delete', data:{id}, timestamp}
        ));
        const applied = [];
        replayQueuedDrafts('notes', state, drafts, item => applied.push(item.data.id), true);
        assert.deepEqual(state.root.map(node => node.id), ['outer', 'unlocked']);
        assert.deepEqual(applied, ['public']);
        """
        self.run_node_esm(body, preamble=PREAMBLE)

    def test_02_tag_rename_delete_replay_on_nodes_and_categories(self):
        """标签改名/删除同时回放到节点与分类，语义与后端一致（改名去重）。"""
        body = """
        const { replayQueuedDrafts } = await import('./data-manage/sync/sync-queue.module.js');
        const { replayDocument, applyTagChange } = await import('./data-manage/sync/relay-actions.module.js');
        const s = {root:[{id:'a',type:'note',tags:['x','y']},{id:'b',type:'note',tags:['y']}],allNodes:[],lockedNodes:[]};
        const rename = {module:'tags',action:'rename',data:{scope:'notes',oldName:'x',newName:'y'},timestamp:1};
        const remove = {module:'tags',action:'delete',data:{scope:'notes',tag:'y'},timestamp:2};
        replayQueuedDrafts('notes', s, [rename]);
        assert.deepEqual(s.root[0].tags, ['y']);
        replayQueuedDrafts('notes', s, [remove]);
        assert.deepEqual(s.root.map(n => n.tags), [[],[]]);
        const categories = [{name:'c',tags:['x','y','z']}];
        const result = replayDocument('tags:notes', categories, [rename, remove],
            (item, content) => applyTagChange(item, 'notes', {categories: content}));
        assert.deepEqual(result[0].tags, ['z']);
        replayQueuedDrafts('literature', {root:[{id:'q',tags:['x']}],allNodes:[],lockedNodes:[]}, [rename]);
        """
        self.run_node_esm(body, preamble=PREAMBLE)

    def test_03_document_snapshot_replay_order_and_conflict_hash(self):
        """整份快照后写覆盖先写；内容指纹与键顺序、空白无关。"""
        body = """
        const { replayDocument, contentHash, canonicalJson } = await import('./data-manage/sync/relay-actions.module.js');
        const first = {module:'doc',action:'replace',data:{doc:'music',content:[{name:'A'}]},timestamp:1};
        const second = {module:'doc',action:'replace',data:{doc:'music',content:[{name:'B'}]},timestamp:2};
        assert.deepEqual(replayDocument('music', [{name:'base'}], [second, first]), [{name:'B'}]);
        assert.deepEqual(replayDocument('music', [{name:'base'}], []), [{name:'base'}]);
        assert.deepEqual(replayDocument('space-tree', {root:[]}, [first]), {root:[]});
        assert.equal(await contentHash({a:1,b:[1,2]}), await contentHash({b:[1,2],a:1}));
        assert.notEqual(await contentHash({a:1}), await contentHash({a:2}));
        assert.equal(canonicalJson({b:undefined,a:1}), '{"a":1}');
        """
        self.run_node_esm(body, preamble=PREAMBLE)

    def test_04_photos_replay_upload_delete_reorder_tags(self):
        """图库草稿：上传、删除、排序、标签按序回放；CDN 地址与相对路径视为同一图片。"""
        body = """
        const { replayPhotos } = await import('./data-manage/sync/relay-actions.module.js');
        const item = (action, data, timestamp) => ({module:'photos',action,data:{category:'travel',...data},timestamp});
        const photos = [{id:'1',path:'photos/images/travel/a.jpg',tags:[]},{id:'2',path:'photos/images/travel/b.jpg',tags:[]}];
        replayPhotos('travel', photos, [
            item('upload',{path:'photos/images/travel/c.jpg',name:'c.jpg'},1),
            item('update_tags',{path:'https://cdn.example/photos/images/travel/b.jpg',tags:['t']},2),
            item('reorder',{order:['photos/images/travel/b.jpg','photos/images/travel/a.jpg']},3),
            item('delete',{path:'photos/images/travel/a.jpg'},4),
            {module:'photos',action:'delete',data:{category:'other',path:'photos/images/travel/b.jpg'},timestamp:5},
        ]);
        assert.deepEqual(photos.map(p => p.path.split('/').pop()), ['b.jpg','c.jpg']);
        assert.deepEqual(photos[0].tags, ['t']);
        assert.equal(photos[1]._pendingRelay, true);
        """
        self.run_node_esm(body, preamble=PREAMBLE)

    def test_05_merge_requests_resolve_registered_actions_only(self):
        """合并只执行注册表登记的动作；未知动作抛错使合并中止并保留草稿。"""
        body = """
        const { resolveMergeRequest } = await import('./data-manage/sync/relay-actions.module.js');
        const cms = resolveMergeRequest({module:'games',action:'move',data:{id:'a',targetParentId:'root'}});
        assert.equal(cms.endpoint, '/api/cms/node?module=games&action=move');
        assert.deepEqual(resolveMergeRequest({module:'photos',action:'reorder',data:{category:'c',order:['p1','p2']}}),
            {endpoint:'/reorder?category=c',body:[{path:'p1'},{path:'p2'}]});
        assert.equal(resolveMergeRequest({module:'tags',action:'rename',data:{scope:'photos-nature',oldName:'a',newName:'b'}}).endpoint,
            '/api/cms/rename_tag?module=photos-nature');
        assert.equal(resolveMergeRequest({module:'doc',action:'replace',data:{doc:'music',content:[]}}).endpoint, '/api/save_music');
        assert.equal(resolveMergeRequest({module:'doc',action:'replace',data:{doc:'tags:space',content:[]}}).endpoint,
            '/api/cms/save_tag_categories?module=space');
        for (const bad of [{module:'album',action:'add',data:{id:'travel'}}, {module:'notes',action:'open_external',data:{}},
                {module:'tags',action:'rename',data:{scope:'../x'}}, {module:'doc',action:'replace',data:{doc:'crypto-keyring'}}]) {
            assert.throws(() => resolveMergeRequest(bad), /未登记/);
        }
        """
        self.run_node_esm(body, preamble=PREAMBLE)

    def test_published_photo_urls_merge_as_local_keys_and_ack_after_success(self):
        """已发布图片的删除、排序和标签草稿统一用逻辑键，成功后才确认。"""
        body = """
        const {mergeRelayQueue}=await import('./data-manage/sync/sync-queue.module.js');
        const root='photos/images/travel/',a='https://cdn.example/'+root+'a%20b.png?v=1#preview';
        const rows=[['delete',{path:a}],['update_tags',{path:a,tags:['旅行']}],
            ['reorder',{order:['/'+root+'c.png',a]}],['upload',{path:root+'d.png',name:'d.png'}]];
        const items=rows.map(([action,data],index)=>({key:'sync_request_'+index,data:{
            module:'photos',action,data:{category:'travel',...data},timestamp:index+1}}));
        const original=JSON.stringify(items),calls=[];let acked=[];
        globalThis.window.location.reload=()=>{};
        globalThis.fetch=async(url,options={})=>{
            if(String(url).endsWith('/api/session'))return {ok:true,json:async()=>({token:'test-session'})};
            const request=new URL(url,'http://localhost:8000'),body=JSON.parse(options.body);
            const paths=Array.isArray(body)?body.map(row=>row.path):[body.path];
            // 与生产后端一致，完整 URL 无法通过本地图片路径边界。
            if(paths.some(path=>!path.startsWith(root)))return {ok:false,status:400,json:async()=>({error:'Invalid media path'})};
            calls.push({path:request.pathname,body,key:request.searchParams.get('_relay_key')});
            return {ok:true,json:async()=>({status:'success'})};
        };
        const manager={config:{relay:{endpoint:'https://relay.example',secret:'test'}},
            _appliedRelayKeys:new Map(),localPendingSessionItems:[],pendingItemsCount:items.length,updateButtonBadge(){}};
        const driver={pull:async()=>({success:true,items}),ack:async(endpoint,secret,keys)=>{
            assert.equal(calls.length,items.length,'全部本地写入完成后才确认云端草稿');
            acked=keys;return {success:true};}};
        assert.equal(await mergeRelayQueue(manager,driver),true);
        assert.deepEqual(calls.map(call=>call.path),['/delete','/api/photos/update_tags_by_path','/reorder','/api/photos/register']);
        assert.deepEqual(calls[0].body,{path:root+'a b.png'});
        assert.deepEqual(calls[1].body,{path:root+'a b.png',tags:['旅行']});
        assert.deepEqual(calls[2].body,[{path:root+'c.png'},{path:root+'a b.png'}]);
        assert.equal(calls[3].body.path,root+'d.png');
        assert.deepEqual(acked,items.map(item=>item.key));
        assert.equal(JSON.stringify(items),original,'保留云端草稿原始载荷与编号');
        """
        self.run_node_esm(body,preamble=PREAMBLE)

    def test_06_merge_conflict_asks_before_overwrite_and_keeps_queue_on_refusal(self):
        """电脑本地已改同一份快照文档：确认覆盖才继续，拒绝则中止且不确认草稿。"""
        body = """
        const { mergeRelayQueue } = await import('./data-manage/sync/sync-queue.module.js');
        const { contentHash } = await import('./data-manage/sync/relay-actions.module.js');
        const base = [{name:'base'}], desktop = [{name:'desktop edit'}], phone = [{name:'phone edit'}];
        globalThis.window.confirm = () => { throw new Error('should use injected confirm'); };
        globalThis.window.location.reload = () => {};
        let current = desktop, saves = 0;
        globalThis.fetch = async (url, options = {}) => {
            if (String(url).includes('/api/session')) return {ok:true,json:async()=>({token:'t'})};
            if (String(url).includes('/api/save_music')) { saves++; return {ok:true,json:async()=>({status:'success'})}; }
            if (String(url).endsWith('data/music-data.json')) return {ok:true,json:async()=>current};
            throw new Error('unexpected ' + url);
        };
        const item = {key:'sync_1',data:{module:'doc',action:'replace',timestamp:1,
            data:{doc:'music',content:phone,baseHash:await contentHash(base)}}};
        const make = () => ({config:{relay:{endpoint:'https://relay.example',secret:'s'}},_appliedRelayKeys:new Map(),
            localPendingSessionItems:[],pendingItemsCount:0,updateButtonBadge(){},openSettingsModal(){},Controller:null});
        let acked = [];
        const driver = {pull:async()=>({success:true,items:[item]}),ack:async(e,s,keys)=>{acked=keys;return {success:true};}};
        assert.equal(await mergeRelayQueue(make(), driver, {confirmOverwrite:()=>false,chooseFailure:async()=>null}), false);
        assert.equal(saves, 0); assert.deepEqual(acked, []);
        assert.equal(await mergeRelayQueue(make(), driver, {confirmOverwrite:()=>true}), true);
        assert.equal(saves, 1); assert.deepEqual(acked, ['sync_1']);
        saves = 0; acked = []; current = base;
        let asked = 0;
        assert.equal(await mergeRelayQueue(make(), driver, {confirmOverwrite:()=>{asked++;return false;}}), true);
        assert.equal(asked, 0); assert.equal(saves, 1);
        """
        self.run_node_esm(body, preamble=PREAMBLE)

    def test_changelog_conflict_checks_each_draft(self):
        """更新日志允许连续保存，独立编辑的草稿不得静默覆盖已合并日志。"""
        body = """
        const { mergeRelayQueue } = await import('./data-manage/sync/sync-queue.module.js');
        const { contentHash } = await import('./data-manage/sync/relay-actions.module.js');
        const base = [{date:'2026-01-01',entries:['原条目']}];
        const first = [{date:'2026-01-01',entries:['第一次编辑']}];
        const second = [{date:'2026-01-01',entries:['连续编辑']}];
        const independent = [{date:'2026-01-01',entries:['另一台设备编辑']}];
        const item = (key, timestamp, content, baseHash) => ({
            key, data:{module:'doc',action:'replace',timestamp,data:{doc:'changelog',content,baseHash}}
        });
        const baseline = await contentHash(base);
        const items = [
            item('first',1,first,baseline),
            item('second',2,second,await contentHash(first)),
            item('independent',3,independent,baseline)
        ];
        let current = base, prompts = 0, acknowledged = [];
        globalThis.fetch = async (url, options = {}) => {
            if (String(url).includes('/api/session')) return {ok:true,json:async()=>({token:'t'})};
            if (String(url).endsWith('data/changelog.json')) return {ok:true,json:async()=>current};
            assert.match(String(url), /api[/]save_changelog[?]/);
            current = JSON.parse(options.body);
            return {ok:true,json:async()=>({status:'success'})};
        };
        const manager = {config:{relay:{endpoint:'https://relay.example',secret:'s'}}, _appliedRelayKeys:new Map(),
            localPendingSessionItems:[], pendingItemsCount:0, updateButtonBadge(){}};
        const driver = {pull:async()=>({success:true,items}),
            ack:async(e,s,keys)=>{acknowledged=keys;return {success:true};}};
        assert.equal(await mergeRelayQueue(manager, driver, {confirmOverwrite:()=>{prompts++;return false;},chooseFailure:async()=>null}), false);
        assert.deepEqual(current, second);
        assert.deepEqual(acknowledged, ['first','second']);
        assert.equal(prompts, 1);
        """
        self.run_node_esm(body, preamble=PREAMBLE)

    def test_snapshot_conflict_preserves_newer_changes_and_pending_draft(self):
        """两个编辑页各自保留读入时的基线；同页连续保存推进基线。"""
        body = """
        const { SyncManager } = await import('./data-manage/sync/sync-manager.module.js');
        const { mergeRelayQueue } = await import('./data-manage/sync/sync-queue.module.js');
        const { contentHash } = await import('./data-manage/sync/relay-actions.module.js');
        const original = [{name:'原数据'}];
        let current = original, queue = [], confirmed = [], prompts = 0;
        const relay = {endpoint:'https://relay.example',secret:'s'};
        const make = () => {
            const sm = new SyncManager(); sm.config = {mode:'relay',relay}; return sm;
        };
        globalThis.fetch = async (url, options = {}) => {
            if (url.includes('/api/pull?')) return Response.json({items:queue});
            if (url.endsWith('/push')) {
                const data = JSON.parse(options.body);
                queue.push({key:data.requestId,data});
                return Response.json({success:true,id:data.requestId});
            }
            if (url === 'data/music-data.json') return Response.json(current);
            assert.match(url, /api[/]save_music[?]/);
            const body = JSON.parse(options.body);
            if (JSON.stringify(body._base) !== JSON.stringify(current)) {
                return Response.json({code:'snapshot_conflict'}, {status:409});
            }
            current = body._snapshot;
            return Response.json({status:'success'});
        };
        const active = make(), stale = make();
        const editing = await active.loadDocument('music', structuredClone(original));
        const outdated = await stale.loadDocument('music', structuredClone(original));
        editing[0].name = '第一次';
        assert.equal((await active.writeDocument('music', editing)).success, true);
        editing[0].name = '同页第二次';
        assert.equal((await active.writeDocument('music', editing)).success, true);
        outdated[0].name = '旧标签页';
        assert.equal((await stale.writeDocument('music', outdated)).success, true);
        assert.equal(queue[1].data.data.baseHash, await contentHash([{name:'第一次'}]));
        assert.equal(queue[2].data.data.baseHash, await contentHash(original));
        const desktop = make();
        desktop.Controller = {loadData:async()=>true,refreshView(){}};
        const driver = {pull:async()=>({success:true,items:queue}),
            ack:async(e,s,keys)=>{ confirmed=keys; return {success:true}; }};
        assert.equal(await mergeRelayQueue(desktop, driver, {confirmOverwrite:()=>{prompts++;return false;},chooseFailure:async()=>null}), false);
        assert.deepEqual(current, editing);
        assert.deepEqual(confirmed, queue.slice(0,2).map(item=>item.key));
        assert.equal(prompts, 1);
        assert.equal(desktop.pendingItemsCount, 1);
        """
        self.run_node_esm(body, preamble=PREAMBLE)

    def test_worker_draft_retry_uses_original_request_after_reload(self):
        """Worker 已接收但手机丢响应，重试沿用草稿键、时间与节点 ID。"""
        body = """
        const { SyncManager } = await import('./data-manage/sync/sync-manager.module.js');
        const { default: worker } = await import('./data-manage/sync/cloudflare-worker-sync.js');
        const items = new Map(), requests = [];
        const env = {SECRET_KEY:'s', KV:{
            get:async key=>JSON.parse(items.get(key) || 'null'),
            list:async()=>({keys:[...items.keys()].map(name=>({name})),list_complete:true}),
            put:async (key,value,options)=>{ assert.equal(options.expirationTtl, 30*24*60*60); items.set(key,value); }
        }};
        globalThis.fetch = async (url, options) => {
            if (url.endsWith('/push')) requests.push(JSON.parse(options.body));
            const response = await worker.fetch(new Request(url, options), env);
            if (url.endsWith('/push') && requests.length === 1) throw Error('response lost');
            return response;
        };
        const sm = new SyncManager();
        sm.saveConfig({mode:'relay',relay:{endpoint:'https://relay.example',secret:'s'}});
        const create = {type:'note',title:'新笔记',parentId:'root'};
        const state = {root:[]};
        assert.equal((await sm.handleRelayAction('notes','add',create,state)).success, false);
        assert.equal(state.root.length, 0);
        const reopened = new SyncManager();
        assert.equal((await reopened.handleRelayAction('notes','add',{...create},state)).success, true);
        assert.equal(requests.length, 2);
        assert.deepEqual(requests[1], requests[0]);
        assert.equal(items.size, 1);
        assert.deepEqual(state.root.map(node=>node.id), [requests[0].data.id]);
        """
        self.run_node_esm(body, preamble=PREAMBLE)

    def test_space_create_retry_keeps_one_node_in_snapshot(self):
        """新增网站保存失败时不改树，同一个表单重试只暂存一个节点。"""
        body = """
        const cards = [], grid = {set innerHTML(_) {cards.length=0;},appendChild:card=>cards.push(card)};
        document.getElementById = id => id === 'category-grid' ? grid : null;
        document.documentElement = __mockEl();
        document.createElement = () => ({...__mockEl(),dataset:{}});
        const { syncManager } = await import('./data-manage/sync/sync-manager.module.js');
        const { AdminModal } = await import('./data-manage/admin/admin-modal.module.js');
        const { initSpaceAdmin } = await import('./custom/space/admin/space-admin.module.js');
        const requests = [];
        globalThis.fetch = async (url, options = {}) => {
            if (url === 'data/space-tree.json') return Response.json({root:[]});
            if (url.includes('/api/pull?')) return Response.json({items:[]});
            assert.ok(url.endsWith('/push'));
            requests.push(JSON.parse(options.body));
            if (requests.length === 1) throw Error('response lost');
            return Response.json({success:true,id:requests.at(-1).requestId});
        };
        syncManager.config = {mode:'relay',relay:{endpoint:'https://relay.example',secret:'s'}};
        let modal;
        AdminModal.open = options => { modal=options; };
        const app = {AppState:{}};
        initSpaceAdmin(app);
        await new Promise(resolve=>setImmediate(resolve));
        cards.at(-1).onclick();
        const form = {name:'网站',url:'https://example.org/',content:'',tags:[],icon:''};
        assert.equal(await modal.onSave(form), false);
        assert.deepEqual(app.AppState.allNodes, []);
        assert.equal(await modal.onSave(form), true);
        assert.equal(app.AppState.allNodes.length, 1);
        assert.equal(requests[1].data.content.root.length, 1);
        assert.deepEqual(requests[1], requests[0]);
        """
        self.run_node_esm(body, preamble=PREAMBLE)

    def test_merge_reports_committed_result_even_if_refresh_fails(self):
        """落盘并确认后，刷新失败仍返回合并成功且移除已确认的会话草稿。"""
        body = """
        const { SyncManager } = await import('./data-manage/sync/sync-manager.module.js');
        const { Toast } = await import('./shared/toast.module.js');
        const manager = new SyncManager();
        manager.config = {mode:'local',relay:{endpoint:'https://relay.example',secret:'s'}};
        manager.Controller = { loadData:async()=>true, refreshView:async()=>{throw Error('view offline');} };
        const warnings = [], errors = [];
        Toast.warning = message => warnings.push(message); Toast.error = message => errors.push(message);
        const payload = {module:'notes',action:'delete',data:{id:'n1'},timestamp:1};
        manager.localPendingSessionItems = [payload];
        let saves = 0, ack = [];
        globalThis.fetch = async (url, options = {}) => {
            if (url.includes('/api/pull?')) return Response.json({items:[{key:'one',data:payload}]});
            if (url.endsWith('/ack')) { ack = JSON.parse(options.body).keys; return Response.json({success:true}); }
            assert.match(url, /api[/]cms[/]node[?]/); saves++;
            return Response.json({success:true});
        };
        assert.equal(await manager.pullAndMerge(), true);
        assert.equal(saves, 1); assert.deepEqual(ack, ['one']);
        assert.deepEqual(manager.localPendingSessionItems, []);
        assert.equal(manager.pendingItemsCount, 0);
        assert.deepEqual(errors, []); assert.match(warnings[0], /已合并并确认.*手动刷新/);
        """
        self.run_node_esm(body, preamble=PREAMBLE)

    def test_07_save_bar_reports_failure_and_stays_visible(self):
        """保存回调返回 false 或抛错：按钮恢复可点击，不得显示已保存。"""
        body = """
        const { SaveButton } = await import('./data-manage/admin/admin-ui.module.js');
        const button = {disabled:false,textContent:''}, cancel = {};
        document.getElementById = id => id === 'global-save-btn' ? button : id === 'global-cancel-btn' ? cancel : null;
        document.querySelectorAll = () => [];
        const delays = []; globalThis.setTimeout = (callback, ms) => { delays.push(ms); return 0; };
        for (const callback of [async () => false, async () => { throw new Error('boom'); }]) {
            delays.length = 0;
            SaveButton.init(document.body, callback, async () => {});
            await button.onclick({stopPropagation(){}});
            assert.equal(button.textContent, '保存修改'); assert.equal(button.disabled, false);
            assert.ok(!delays.includes(SaveButton.RESET_DELAY), '失败时不得安排“已保存”后的收起');
        }
        SaveButton.init(document.body, async () => true, async () => {});
        await button.onclick({stopPropagation(){}});
        assert.equal(button.textContent, '✅ 已保存');
        """
        self.run_node_esm(body, preamble=PREAMBLE)

    def test_08_music_save_returns_real_result_and_keeps_group_identity(self):
        """音乐保存返回真实结果；密码组标识随密文一并保存，运行时字段被剔除。"""
        body = """
        const music = await import('./custom/music/viewer/music-ui.module.js');
        let sent;
        const session = url => String(url).endsWith('/api/session');
        const sessionReply = {ok:true,json:async()=>({token:'t'})};
        globalThis.fetch = async (url, options) => {
            if (session(url)) return sessionReply;
            sent = JSON.parse(options.body); return {ok:false};
        };
        music.UI.libraryData = [{_enc:'enc:x',_group:'g_1',_runtime:1,name:'n'}];
        assert.equal(await music.saveData(), false);
        assert.deepEqual(sent, [{_enc:'enc:x',_group:'g_1',name:'n'}]);
        globalThis.fetch = async url => session(url) ? sessionReply : {ok:true};
        assert.equal(await music.saveData(), true);
        globalThis.fetch = async url => { if (session(url)) return sessionReply; throw new Error('offline'); };
        assert.equal(await music.saveData(), false);
        """
        self.run_node_esm(body, preamble=(MOCK_LOCAL_STORAGE, MOCK_DOM, mock_window('/music.html', hostname='localhost', is_admin=False),
                                          "document.addEventListener = () => {};"))

    def test_09_tag_save_failure_is_not_reported_as_success(self):
        """标签分类保存失败返回 false 且不改内存；成功才更新。"""
        body = """
        const { Controller } = await import('./custom/cms/admin/cms-controller.module.js');
        const { setupBaseAdapter } = await import('./custom/cms/cms-adapter.module.js');
        const { TagsApi } = await import('./custom/cms/admin/cms-tags-api.module.js');
        const { syncManager } = await import('./data-manage/sync/sync-manager.module.js');
        syncManager.config = {mode:'local',relay:{endpoint:'https://relay.example',secret:''}};
        Controller.AppState.tagCategories = [{name:'old',tags:[]}];
        globalThis.fetch = async () => { throw new Error('network down'); };
        assert.equal(await Controller.saveTagCategories([{name:'new',tags:[]}]), false);
        assert.equal(Controller.AppState.tagCategories[0].name, 'old');
        const adapter = setupBaseAdapter('space', () => {});
        adapter.AppState.tagCategories = [{name:'old',tags:[]}];
        assert.equal(await adapter.mockController.saveTagCategories([{name:'new',tags:[]}]), false);
        assert.equal(adapter.AppState.tagCategories[0].name, 'old');
        globalThis.fetch = async (url, options) => {
            if (url.includes('/api/cms/tag_categories')) return Response.json([{name:'old',tags:[]}]);
            const saved = JSON.parse(options.body);
            assert.deepEqual(saved._base, [{name:'old',tags:[]}]);
            return Response.json({snapshot:saved._snapshot});
        };
        await TagsApi.getCategories('space');
        assert.equal(await adapter.mockController.saveTagCategories([{name:'new',tags:[]}]), true);
        assert.equal(adapter.AppState.tagCategories[0].name, 'new');
        // 云端模式：标签分类以整份快照入队，携带基线指纹；入队失败同样返回 false
        syncManager.config = {mode:'relay',relay:{endpoint:'https://relay.example',secret:'s'}};
        const pushed = []; let pushOk = true;
        globalThis.fetch = async (url, options = {}) => {
            if (url.endsWith('/api/drafts/push')) { if (!pushOk) return {ok:false,status:500,text:async()=>'down'};
                pushed.push(JSON.parse(options.body)); return {ok:true,json:async()=>({id:'1'})}; }
            if (url.includes('/api/pull?')) return {ok:true,json:async()=>({items:[]})};
            if (url.includes('tag-categories.json')) return {ok:true,json:async()=>[{name:'old',tags:[]}]};
            throw new Error('unexpected ' + url);
        };
        await TagsApi.getCategories('record');
        assert.equal(await Controller.saveTagCategories([{name:'cloud',tags:['t']}]), true);
        assert.equal(pushed[0].module, 'doc'); assert.equal(pushed[0].data.doc, 'tags:record');
        assert.equal(pushed[0].data.content[0].name, 'cloud'); assert.match(pushed[0].data.baseHash, /^[0-9a-f]{64}$/);
        pushOk = false;
        assert.equal(await Controller.saveTagCategories([{name:'lost',tags:[]}]), false);
        assert.equal(Controller.AppState.tagCategories[0].name, 'cloud');
        """
        self.run_node_esm(body, preamble=(MOCK_LOCAL_STORAGE, MOCK_SESSION_STORAGE, MOCK_DOM,
                                          mock_window('/admin-cms.html', hostname='example.com', is_admin=True)))

    def test_10_worker_pull_follows_kv_pagination(self):
        """Worker 拉取必须跟随 KV 分页游标，跨页草稿不得漏读。"""
        body = """
        const { default: worker } = await import('./data-manage/sync/cloudflare-worker-sync.js');
        const key = name => ({name, metadata:{bytes:64}});
        const pages = [{keys:[key('sync_1')],list_complete:false,cursor:'c1'}, {keys:[key('sync_2')],list_complete:true}];
        const seen = [];
        const kv = {list: async ({cursor}) => { seen.push(cursor); return pages[cursor ? 1 : 0]; },
                    get: async name => ({module:'x',name})};
        const response = await worker.fetch(new Request('https://relay.invalid/api/pull', {headers:{'x-sync-key':'k'}}),
            {SECRET_KEY:'k', MAERS_SYNC_KV: kv}, {});
        const { items } = await response.json();
        assert.deepEqual(items.map(i => i.key), ['sync_1','sync_2']);
        assert.deepEqual(seen, [undefined, 'c1']);
        """
        self.run_node_esm(body)

    def test_large_photo_queue_pulls_within_worker_subrequest_budget(self):
        """客户端跨过空页并取齐 57 张照片，每个请求的存储查询都有上限。"""
        body = """
        const { default: worker } = await import('./data-manage/sync/cloudflare-worker-sync.js');
        const { cloudflareRelay } = await import('./data-manage/sync/cloudflare-relay.module.js');
        const keys = Array.from({length: 57}, (_, i) => ({name: `sync_${i}`, metadata:{bytes:128}}));
        let checks = 0;
        let failAt = null;
        const counts = [];
        const env = {SECRET_KEY:'test', KV:{
            async list({cursor,limit}) {
                if (!cursor) return {keys:[], list_complete:false, cursor:'page:0+'};
                const start = Number(cursor.slice(5,-1));
                if (start === failAt) throw Error('KV unavailable');
                const end = start + limit;
                return {keys:keys.slice(start,end), list_complete:end >= keys.length, cursor:`page:${end}+`};
            },
            async get(name) {
                if (++checks > 50) throw Error('Too many subrequests');
                return {module:'photos',action:'upload',
                    data:{path:`photos/images/travel/${name}.jpg`}};
            }
        }};
        globalThis.fetch = async (url, options) => {
            checks = 0;
            const response = await worker.fetch(new Request(url, options), env, {});
            counts.push(checks);
            return response;
        };
        const result = await cloudflareRelay.pull('https://relay.example', 'test');
        assert.equal(result.success, true);
        assert.deepEqual(result.items.map(item => item.key), keys.map(key => key.name));
        assert.deepEqual(counts, [0, 20, 20, 17]);
        failAt = 20;
        const failed = await cloudflareRelay.pull('https://relay.example', 'test');
        assert.equal(failed.success, false);
        assert.deepEqual(failed.items, []);
        """
        self.run_node_esm(body)

    def test_11_cloud_git_commit_is_removed(self):
        """云端直提已移除：不得再存在绕过本地合并的提交通道。"""
        body = """
        const module = await import('./data-manage/sync/git-commit.module.js');
        assert.equal(typeof module.gitCommitManager.commitDraftsViaGitHub, 'undefined');
        assert.equal(typeof module.gitCommitManager.commitAndPushLocal, 'function');
        """
        self.run_node_esm(body, preamble=PREAMBLE)

    def test_cloud_private_draft_replays_cipher_and_seals_document(self):
        body = """
        const { getSessionKey, setSessionKeyRaw, sha256Hex, unwrapRecord, wrapRecord } =
            await import('./data-manage/encrypt/crypto.module.js');
        const { STUDIO_ENTRY_KEY } = await import('./data-manage/api-client.module.js');
        const { openPrivateDrafts, PrivateDocument } = await import('./data-manage/encrypt/private-drafts.module.js');
        const raw = crypto.getRandomValues(new Uint8Array(32));
        setSessionKeyRaw(raw);
        sessionStorage.setItem(STUDIO_ENTRY_KEY, 'active');
        const dekId = (await sha256Hex('maers-dek-id|' + Buffer.from(raw).toString('base64'))).slice(0,16);
        globalThis.fetch = async () => Response.json({v: 1, dek_id: dekId, pw: {salt:'test', wrap:'test'}});
        const key = await getSessionKey();
        const source = [await wrapRecord({id: 'private', name: 'secret', children: [{id:'child', name:'child'}]}, key)];
        const pending = [];
        const drafts = await openPrivateDrafts('album', source, pending, async data => {
            assert.deepEqual(Object.keys(data).sort(), ['enc','group','revision','source']);
            assert.ok(!JSON.stringify(data).includes('new private'));
            pending.push({module:'private', action:'replace', data, timestamp:pending.length + 1});
            return {success:true};
        });
        const entry = drafts.get(source[0]);
        await entry.edit(record => { record.name = 'new private'; });
        await entry.edit(record => { record.children[0].name = 'new private child'; });
        const refreshed = structuredClone(source);
        const read = await openPrivateDrafts('album', refreshed, pending, () => {});
        assert.equal(read.get(refreshed[0]).payload.children[0].name, 'new private child');

        const doc = new PrivateDocument(['children']);
        const opened = await doc.open([source[0], {id: 'public', name: 'Public'}]);
        opened[0].children[0].name = 'private changed';
        const sealed = await doc.seal(opened);
        assert.equal((await unwrapRecord(sealed[0], key)).children[0].name, 'private changed');
        assert.deepEqual(sealed[1], {id:'public', name:'Public'});
        await assert.rejects(() => doc.seal([...opened, opened[0].children[0]]), /加密边界/);
        """
        self.run_node_esm(body, preamble=(*PREAMBLE, MOCK_SESSION_STORAGE))

    def test_cloud_private_kv_upload_and_read_require_group_token(self):
        body = """
        const { default: worker } = await import('./data-manage/sync/cloudflare-worker-sync.js');
        const { sha256Hex } = await import('./data-manage/encrypt/crypto.module.js');
        const group = 'g_' + '1'.repeat(32);
        const token = 'a'.repeat(64);
        const objects = new Map([['_maers/private-tokens/' + group + '.json',
            {body: JSON.stringify({hash: await sha256Hex(token)})}]]);
        const bucket = {
            get: async key => objects.get(key),
            put: () => assert.fail('private formal bucket write')
        };
        const kv = memoryKV();
        const env = {SECRET_KEY:'key', PRIVATE_PHOTOS_BUCKET:bucket, MAERS_SYNC_KV: kv,
            PUBLIC_PHOTOS_BUCKET:{put: () => assert.fail('Private image reached public bucket')}};
        const upload = (secret, groupToken) => {
            const form = new FormData();
            form.append('file', new Blob([Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)], {type:'image/png'}), 'test.png');
            return worker.fetch(new Request('https://relay.invalid/api/drafts/upload?g=' + group, {
                method:'POST', headers:{'x-sync-key': secret, 'x-private-media-token':groupToken}, body:form
            }), env, {});
        };
        assert.equal((await upload('wrong', token)).status, 401);
        assert.equal((await upload('key', 'b'.repeat(64))).status, 403);
        assert.equal(objects.size, 1);
        const result = await upload('key', token);
        assert.equal(result.status, 200);
        const { relPath, path } = await result.json();
        assert.equal(objects.size, 1);
        assert.equal(kv.entries.size, 1);
        const preview = path + '&g=' + group;
        assert.equal((await worker.fetch(new Request(preview + '&t=wrong'), env, {})).status,403);
        const viaGroup = await worker.fetch(new Request(preview + '&t=' + token), env, {});
        assert.equal(viaGroup.status, 200);
        const download='https://relay.invalid/api/drafts/media?path='+encodeURIComponent(relPath)+'&g='+group;
        const viaSyncKey = await worker.fetch(new Request(download,
            {headers:{'x-sync-key':'key'}}), env, {});
        assert.equal(viaSyncKey.status, 403);
        assert.equal((await worker.fetch(new Request(download,
            {headers:{'x-sync-key':'key','x-private-media-token':token}}), env, {})).status,200);
        """
        self.run_node_esm(body, preamble=(MOCK_KV,))


class Test14_RelayBackendEntrances(SandboxTestCase):
    """后端回执入口：数组请求体经查询参数携带回执，同一草稿只执行一次。"""

    def test_archive_only_accepts_retired_uploads_and_keeps_original_record(self):
        import config
        item = {'key': 'sync_request_12345678-1234-4234-8234-123456789abc', 'data': {
            'module': 'photos', 'action': 'upload', 'awaitingPhoto': True,
            'data': {'path': 'photos/images/travel/old.jpg'}}}
        body = {'source': 'https://relay.example', 'item': item}
        self.assertEqual(self.call_post('/api/relay/archive-upload', body=body), (200, {'archived': True}))
        root = os.path.join(config.PROJECT_ROOT, '_studio', '.local', 'relay-retired')
        files = os.listdir(root)
        self.assertEqual(len(files), 1)
        self.assertEqual(self.load_json(os.path.join(root, files[0])), body)
        self.assertEqual(self.call_post('/api/relay/archive-upload', body=body)[0], 200)
        del item['data']['awaitingPhoto']
        self.assertEqual(self.call_post('/api/relay/archive-upload', body=body)[0], 400)
        self.assertTrue(self.load_json(os.path.join(root, files[0]))['item']['data']['awaitingPhoto'])

    def test_kv_image_reader_sets_client_headers_and_identifies_gateway_block(self):
        import io
        from unittest import mock
        from urllib.error import HTTPError
        from services import relay_media
        image = b'original-image'
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.headers = {'X-Maers-Image-Size': str(len(image)), 'X-Maers-Bucket': 'default'}
        response.read.return_value = image
        opener = mock.Mock()
        opener.open.return_value = response
        path = 'photos/images/travel/a.png'
        with mock.patch.object(relay_media, 'build_opener', return_value=opener):
            with relay_media.bind('https://relay.example', 'sync-password') as received:
                self.assertEqual(relay_media.read(path).data, image)
                self.assertEqual(received, [path])
            request = opener.open.call_args.args[0]
            self.assertEqual(request.get_header('User-agent'), relay_media.USER_AGENT)
            self.assertEqual(request.get_header('X-sync-key'), 'sync-password')
            opener.open.side_effect = HTTPError(request.full_url, 403, 'Forbidden', {}, io.BytesIO(b'error code: 1010'))
            with relay_media.bind('https://relay.example', 'sync-password') as received:
                with self.assertRaisesRegex(ValueError, 'Cloudflare.*1010'):
                    relay_media.read(path)
                self.assertEqual(received, [])

    def test_cloud_cms_attachment_merge_restores_heic_and_cover(self):
        """文章图片随草稿合并，缺图时原图、衍生图和索引一起回滚。"""
        import io
        from PIL import Image
        from unittest import mock
        from services import media_jobs, relay_media
        import routes
        from .helpers import make_test_png_bytes

        image_path = 'photos/images/_games/20261106_120000_' + '1' * 32 + '.heic'
        cover_path = 'photos/images/gamecovers/20261106_120000_' + '2' * 32 + '.png'
        with Image.new('RGB', (64, 48), 'red') as image, io.BytesIO() as encoded:
            image.save(encoded, 'HEIF')
            original = encoded.getvalue()
        staged = {image_path: original}
        self.assertEqual(self.cms('add', {'id': 'cloud-note', 'type': 'note',
                                        'title': 'Cloud note', 'parentId': 'root'}, module='games')[0], 200)
        query = {'module': ['games'], 'action': ['update'], '_relay_source': ['https://relay.example'],
                 '_relay_key': ['cms-image-merge']}
        body = {'id': 'cloud-note', 'data': {'content': f'![]({image_path})', 'coverImage': cover_path}}
        endpoint = '/api/cms/node'
        def read(path):
            endpoint_url, secret, images = relay_media._source.get()
            self.assertEqual((endpoint_url, secret), ('https://relay.example', 'test-access'))
            if path in staged:
                images.append(path)
                return relay_media.DraftImage(staged[path], 'default', None)

        with mock.patch.object(relay_media, 'read', side_effect=read):
            merge = lambda: routes.dispatch_post(endpoint, query, body, relay_secret='test-access')
            self.assertEqual(merge()[0], 400)
            self.assertEqual(self.gallery_json(), {})
            self.assertFalse(os.path.isfile(self.root_path(image_path)))
            self.assertFalse(media_jobs.pending())
            staged[cover_path] = make_test_png_bytes('blue')
            code, result = merge()
            self.assertEqual(code, 200)
            self.assertEqual(set(result['_draft_media']), {image_path, cover_path})
            staged.clear()
            self.assertEqual(merge(), (code, result), '重复确认必须复用已保存的回执')
        for category, path in (('_games', image_path), ('gamecovers', cover_path)):
            row, = self.gallery_json()[category]
            self.assertEqual(row['path'], path)
            for field in ('path', 'thumb', 'preview'):
                self.assertTrue(os.path.isfile(self.root_path(row[field])))
        with open(self.root_path(image_path), 'rb') as file:
            self.assertEqual(file.read(), original)
        jobs = media_jobs.pending()
        self.assertEqual(len(jobs), 6)
        self.assertTrue(all(job['deferred'] for job in jobs))
        self.assertEqual(media_jobs.retry()['completed'], 0)
        self.assertNotIn(image_path, self.mock_s3.buckets['pub-bucket'])
        self.assertEqual(media_jobs.retry(for_publish=True)['completed'], 6)
        self.assertIn(image_path, self.mock_s3.buckets['pub-bucket'])

    def test_cms_relay_delete_preserves_protected_records(self):
        """旧草稿删除密文或其父目录时保留原记录和待合并状态。"""
        path = self.data_path('notes-tree.json')
        locked = {'id': 'locked', 'type': 'locked', 'children': None, '_enc': 'enc:placeholder'}
        folder = {'id': 'folder', 'type': 'folder', 'title': 'Folder', 'children': [locked]}
        public = {'id': 'public', 'type': 'folder', 'title': 'Public', 'children': []}
        storage.write_json(path, {'root': [folder, public]})
        query = {'module': ['notes'], 'action': ['delete'], '_relay_source': ['https://relay.example']}
        endpoint = '/api/cms/node'
        for index, body in enumerate((
                {'id': 'locked'}, {'id': 'folder'},
                {'id': 'public', 'purge_private': ['photos/images/example/private.png']})):
            self.assertEqual(self.call_post(endpoint, {**query, '_relay_key': [f'rejected-{index}']}, body)[0], 400)
            self.assertEqual(self.load_json(path), {'root': [folder, public]})
        self.assertFalse(os.path.isfile(self.data_path('.relay-receipts.json')))
        self.assertEqual(self.call_post(endpoint, {**query, '_relay_key': ['public-delete']}, {'id': 'public'})[0], 200)
        self.assertEqual(self.load_json(path), {'root': [folder]})
        self.assertEqual(self.cms('delete', {'id': 'locked'})[0], 200)

    def test_01_array_body_relay_via_query_executes_once(self):
        image = self.upload_png('travel', 'a.png', 'red')
        other = self.upload_png('travel', 'b.png', 'blue')
        query = {'category': ['travel'], '_relay_source': ['https://relay.example'], '_relay_key': ['sync_9'],
                 '_operation': ['1' * 32]}
        order = [{'path': other['path']}, {'path': image['path']}]
        first = self.call_post('/reorder', query, order)
        self.assertEqual(first[0], 200)
        self.assertEqual([row['path'] for row in self.gallery_json()['travel']], [other['path'], image['path']])
        self.call_post('/reorder', {'category': ['travel']}, [{'path': image['path']}, {'path': other['path']}])
        replay_query = {**query, '_operation': ['2' * 32]}
        replay = self.call_post('/reorder', replay_query, order)
        self.assertEqual(replay, first)
        self.assertEqual([row['path'] for row in self.gallery_json()['travel']], [image['path'], other['path']])
        self.assertEqual(self.call_post('/reorder', replay_query, [{'path': image['path']}])[0], 409)

    def test_02_relay_metadata_rejected_on_unregistered_routes(self):
        query = {'_relay_source': ['https://relay.example'], '_relay_key': ['sync_1']}
        self.assertEqual(self.call_post('/api/add_category', query, {'id': 'x', 'title': 'x'})[0], 400)
        self.assertEqual(self.call_post('/api/save_music', {'_relay_source': ['s']}, [])[0], 400)

    def test_03_photo_tags_by_path(self):
        image = self.upload_png('travel', 'a.png', 'green')
        self.assertEqual(self.call_post('/api/photos/update_tags_by_path',
                                        body={'path': image['path'], 'tags': ['海', '日落']})[0], 200)
        self.assertEqual(self.gallery_json()['travel'][0]['tags'], ['海', '日落'])
        self.assertEqual(self.call_post('/api/photos/update_tags_by_path',
                                        body={'path': 'photos/images/travel/missing.png', 'tags': []})[0], 400)
        self.assertEqual(self.call_post('/api/photos/update_tags_by_path',
                                        body={'path': '../outside.png', 'tags': []})[0], 400)

    def test_04_save_music_relay_receipt_is_durable(self):
        query = {'_relay_source': ['https://relay.example'], '_relay_key': ['sync_music']}
        data = [{'name': '分类', 'collections': []}]
        self.assertEqual(self.call_post('/api/save_music', {**query}, data)[0], 200)
        self.assertTrue(os.path.isfile(self.data_path('.relay-receipts.json')))
        self.assertEqual(self.call_post('/api/save_music', {**query}, data + [{'name': '另一份', 'collections': []}])[0], 409)

    def test_snapshot_compare_and_save_keeps_newer_local_version(self):
        """本地旧页不能覆盖新版本；中继回执先于冲突校验，重试只返回原结果。"""
        route = '/api/save_music'
        base, first, second = ([{'name': name}] for name in ('旧版本', '第一次保存', '第二次保存'))
        self.assertEqual(self.call_post(route, body=base)[0], 200)
        self.assertEqual(self.call_post(route, body={'_base': base, '_snapshot': first}), (200, {'snapshot': first}))
        self.assertEqual(self.call_post(route, body={'_base': base, '_snapshot': first}), (200, {'snapshot': first}))
        code, result = self.call_post(route, body={'_base': base, '_snapshot': second})
        self.assertEqual((code, result['code']), (409, 'snapshot_conflict'))
        self.assertEqual(self.load_json(self.data_path('music-data.json')), first)
        query = {'_relay_source': ['https://relay.example'], '_relay_key': ['same-request'], '_operation': ['1' * 32]}
        self.assertEqual(self.call_post(route, query, {'_base': None, '_snapshot': second})[0], 409)
        accepted = self.call_post(route, query, {'_base': first, '_snapshot': second})
        self.assertEqual(accepted[0], 200)
        self.assertEqual(self.call_post(route, body=first)[0], 200)
        replay_query = {**query, '_operation': ['2' * 32]}
        self.assertEqual(self.call_post(route, replay_query, {'_base': None, '_snapshot': second}), accepted)
        self.assertEqual(self.call_post(route, replay_query, {'_base': None, '_snapshot': first})[0], 409)
        self.assertEqual(self.load_json(self.data_path('music-data.json')), first)

    def test_markdown_conflict_confirmation_backup_and_replay(self):
        """覆盖需确认当前版本并备份；重试复用原草稿回执，不覆盖后续修改。"""
        import hashlib
        from pathlib import Path
        import routes

        digest = lambda text: hashlib.sha256(text.encode('utf-8')).hexdigest()
        self.add_node('conflict-note', '冲突正文')
        local = '电脑新版本\n'
        self.assertEqual(self.cms('update', {'id': 'conflict-note', 'data': {'content': local}})[0], 200)
        query = {'module': ['notes'], 'action': ['update'], '_relay_source': ['https://relay.example'],
                 '_relay_key': ['first-draft']}
        body = {'id': 'conflict-note', 'data': {'content': '手机第一次修改', 'expectedRevision': digest('原文')}}
        post = lambda q, b: routes.dispatch_post('/api/cms/node', q, b, relay_secret='test')
        code, result = post(query, body)
        self.assertEqual((code, result['code'], result['currentRevision']), (409, 'markdown_conflict', digest(local)))
        self.assertEqual(post(query, {**body, '_overwriteRevision': digest('已过期的确认')})[0], 409)
        self.assertEqual(self.cms('update', {**body, '_overwriteRevision': digest(local)})[0], 400)
        backup_root = Path(self.root_path('_studio', '.local', 'markdown-conflicts'))
        self.assertEqual(list(backup_root.glob('**/*.md')), [])
        self.assertEqual(post(query, {**body, '_overwriteRevision': digest(local)})[0], 200)
        backups = list(backup_root.glob('**/*.md'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(encoding='utf-8'), local)
        second = {'id': 'conflict-note', 'data': {'content': '手机第二次修改', 'expectedRevision': digest('手机第一次修改')}}
        self.assertEqual(post({**query, '_relay_key': ['second-draft']}, second)[0], 200)
        self.assertEqual(post({**query, '_relay_key': ['other-device']}, body)[0], 409)
        self.assertEqual(post(query, body)[0], 200)
        self.assertEqual(post(query, {**body, 'data': {**body['data'], 'content': '不同载荷'}})[0], 409)
        path = self.root_path('markdown', 'notes', 'root-冲突正文.md')
        self.assertEqual(Path(path).read_text(encoding='utf-8'), '手机第二次修改')
        self.assertEqual(len(list(backup_root.glob('**/*.md'))), 1)

    def test_changelog_draft_persists_via_relay(self):
        query = {'_relay_source': ['https://relay.example'], '_relay_key': ['sync_changelog']}
        data = [{'date': '2026-01-01', 'entries': ['更新日志草稿']}]
        self.assertEqual(self.call_post('/api/save_changelog', query, data)[0], 200)
        self.assertEqual(self.call_get('/api/changelog'), (200, data))
        self.assertEqual(self.call_post('/api/save_changelog', query, [])[0], 409)
