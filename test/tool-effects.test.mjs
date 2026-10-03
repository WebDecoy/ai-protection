import test from 'node:test';
import assert from 'node:assert/strict';
import {inferToolEffect,snapshotToolHints,snapshotToolEffect} from '../tool-effects.mjs';
for(const [name,schema,hints,level,reason] of [
 ['deleteUser',{},undefined,'destructive','name_destructive'],
 ['get_user',{},undefined,'read_only','name_read_only'],
 ['send_email',{},undefined,'mutating','name_mutating'],
 ['opaque',{},undefined,'unknown','insufficient_signals'],
 ['opaque',{}, {readOnlyHint:true},'read_only','annotation_read_only'],
 ['opaque',{}, {readOnlyHint:false},'mutating','annotation_mutating'],
 ['opaque',{}, {destructiveHint:true},'destructive','annotation_destructive'],
 ['opaque',{}, {readOnlyHint:true,destructiveHint:true},'read_only','annotation_read_only'],
 ['delete_user',{}, {readOnlyHint:true},'destructive','conflicting_hints'],
 ['query',{properties:{operation:{enum:['read','delete']}}},undefined,'destructive','schema_destructive'],
 ['opaque',{properties:{method:{const:'POST'}}},undefined,'mutating','schema_mutating'],
 ['get_record',{description:'delete all data',properties:{email:{type:'string'}}},undefined,'read_only','name_read_only'],
 ['get_record',{properties:{action:{enum:['update']}}},{readOnlyHint:true},'mutating','conflicting_hints']
])test(`${name} -> ${level} / ${reason}`,()=>{
 assert.deepEqual(inferToolEffect(name,schema,hints),{schema:1,level,reason});
});
test('only fixed effect codes and boolean annotation hints survive snapshots',()=>{
 assert.deepEqual(snapshotToolHints({readOnlyHint:true,title:'private',unknown:'private'}),{readOnlyHint:true});
 assert.throws(()=>snapshotToolHints({readOnlyHint:'true'}));
 assert.throws(()=>snapshotToolEffect({schema:1,level:'read_only',reason:'name_destructive'}));
 assert.throws(()=>snapshotToolEffect({schema:2,level:'read_only',reason:'name_read_only'}));
 assert.deepEqual(snapshotToolEffect({schema:1,level:'unknown',reason:'insufficient_signals',raw:'secret'}),{schema:1,level:'unknown',reason:'insufficient_signals'});
});
