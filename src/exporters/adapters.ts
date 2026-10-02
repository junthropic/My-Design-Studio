import JSZip from 'jszip';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Project, ExportContext, ExportResult } from '../core/types.ts';
import { resolveDesign } from '../core/design.ts';
import { prepareOutput, result, safeProject, slug, writeManifest, type Loss } from './common.ts';
import { addAssets } from './packages.ts';

const aeScript = String.raw`/* Design Studio: run with File > Scripts > Run Script File. Creates a new comp without deleting existing work. */
(function(){
 function parseJSON(text){
  var at=0;
  function white(){while(at<text.length&&/\s/.test(text.charAt(at)))at++;}
  function string(){var out='';at++;while(at<text.length){var c=text.charAt(at++);if(c==='"')return out;if(c==='\\'){c=text.charAt(at++);if(c==='u'){var hex=text.substr(at,4);if(!/^[0-9a-f]{4}$/i.test(hex))throw Error('Invalid Unicode');out+=String.fromCharCode(parseInt(hex,16));at+=4;}else{var escapes={'"':'"','\\':'\\','/':'/','b':'\b','f':'\f','n':'\n','r':'\r','t':'\t'};if(!escapes.hasOwnProperty(c))throw Error('Invalid escape');out+=escapes[c];}}else{if(c.charCodeAt(0)<32)throw Error('Invalid string');out+=c;}}throw Error('Unterminated string');}
  function value(){white();var c=text.charAt(at);if(c==='"')return string();if(c==='['){at++;var arr=[];white();if(text.charAt(at)===']'){at++;return arr;}while(true){arr.push(value());white();c=text.charAt(at++);if(c===']')return arr;if(c!==',')throw Error('Invalid array');}}if(c==='{'){at++;var obj={};white();if(text.charAt(at)==='}'){at++;return obj;}while(true){white();if(text.charAt(at)!=='"')throw Error('Invalid key');var key=string();white();if(text.charAt(at++)!==':')throw Error('Invalid object');obj[key]=value();white();c=text.charAt(at++);if(c==='}')return obj;if(c!==',')throw Error('Invalid object');}}var rest=text.substr(at),match=/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(rest);if(match){at+=match[0].length;return Number(match[0]);}if(rest.substr(0,4)==='true'){at+=4;return true;}if(rest.substr(0,5)==='false'){at+=5;return false;}if(rest.substr(0,4)==='null'){at+=4;return null;}throw Error('Invalid JSON');}
  var parsed=value();white();if(at!==text.length)throw Error('Trailing JSON data');return parsed;
 }
 var root=File($.fileName).parent, file=File(root.fsName+'/scene.json');file.encoding='UTF-8';if(!file.open('r'))throw Error('scene.json missing');var data=parseJSON(file.read());file.close();
 function rgb(c){return [parseInt(c.substr(1,2),16)/255,parseInt(c.substr(3,2),16)/255,parseInt(c.substr(5,2),16)/255];}
 function token(v,fallback){if(v&&v.charAt(0)==='{')return data.tokens[v.slice(1,-1)]||fallback;return v||fallback;}
 function number(v,fallback){return typeof v==='number'?v:fallback;}
 app.beginUndoGroup('Import Design Studio');try{
 if(!app.project)app.newProject();var duration=0;for(var i=0;i<data.motion.scenes.length;i++)duration+=data.motion.scenes[i].durationFrames;
 var comp=app.project.items.addComp(data.name,data.motion.width,data.motion.height,1,duration/data.motion.fps,data.motion.fps);comp.bgColor=rgb(data.tokens['color.bg']);
 var bg=comp.layers.addSolid(rgb(data.tokens['color.bg']),'Background',comp.width,comp.height,1,comp.duration);if(data.motion.transparent)bg.enabled=false;
 var assets={};for(var a=0;a<data.assets.length;a++){var asset=data.assets[a];try{assets[asset.id]=app.project.importFile(new ImportOptions(File(root.fsName+'/'+asset.relativePath)));}catch(importError){}}
 var offset=0;
 for(var s=0;s<data.motion.scenes.length;s++){var scene=data.motion.scenes[s];
  for(var j=0;j<scene.elements.length;j++){var e=scene.elements[j],layer=null,fill=rgb(token(e.fill,data.tokens['color.accent'])),color=rgb(token(e.color,data.tokens['color.text']));
   if(e.type==='text'){layer=comp.layers.addBoxText([e.w,e.h],e.text||'');var td=layer.property('ADBE Text Properties').property('ADBE Text Document').value;td.font=data.font;td.fontSize=e.fontSize||36;td.fillColor=color;td.applyFill=true;td.applyStroke=false;td.leading=td.fontSize*data.tokens['font.lineHeight'];td.autoLeading=false;layer.property('ADBE Text Properties').property('ADBE Text Document').setValue(td);layer.property('ADBE Transform Group').property('ADBE Anchor Point').setValue([e.w/2,e.h/2]);}
   else if(e.type==='shape'){layer=comp.layers.addShape();var contents=layer.property('ADBE Root Vectors Group');if(e.shape==='ellipse'){var shape=contents.addProperty('ADBE Vector Shape - Ellipse');shape.property('ADBE Vector Ellipse Size').setValue([e.w,e.h]);}else{var shape=contents.addProperty('ADBE Vector Shape - Rect');shape.property('ADBE Vector Rect Size').setValue([e.w,e.h]);}var paint=contents.addProperty('ADBE Vector Graphic - Fill');paint.property('ADBE Vector Fill Color').setValue(fill);}
   else if((e.type==='image'||e.type==='video')&&assets[e.assetId]){layer=comp.layers.add(assets[e.assetId]);layer.property('ADBE Transform Group').property('ADBE Scale').setValue([e.w/layer.source.width*100,e.h/layer.source.height*100]);}
   if(!layer)continue;layer.name=e.id+' '+(e.text||e.type).substr(0,60);layer.startTime=offset/data.motion.fps;layer.inPoint=(offset+(e.startFrame||0))/data.motion.fps;layer.outPoint=(offset+Math.min(scene.durationFrames,number(e.endFrame,scene.durationFrames)))/data.motion.fps;
   var tr=layer.property('ADBE Transform Group');tr.property('ADBE Position').setValue([e.x+e.w/2,e.y+e.h/2]);tr.property('ADBE Opacity').setValue(number(e.opacity,1)*100);tr.property('ADBE Rotate Z').setValue(e.rotation||0);
   var keys=e.keyframes||[],positionFrames={};for(var k=0;k<keys.length;k++){var key=keys[k],time=(offset+key.frame)/data.motion.fps;if(key.property==='x'||key.property==='y')positionFrames[key.frame]=true;else if(key.property==='opacity')tr.property('ADBE Opacity').setValueAtTime(time,Number(key.value)*100);else if(key.property==='rotation')tr.property('ADBE Rotate Z').setValueAtTime(time,Number(key.value));else if(key.property==='scale'){var base=layer.source?[e.w/layer.source.width*100,e.h/layer.source.height*100]:[100,100];tr.property('ADBE Scale').setValueAtTime(time,[base[0]*Number(key.value),base[1]*Number(key.value)]);}}
   function axisAt(prop,frame,initial){var arr=[];for(var q=0;q<keys.length;q++)if(keys[q].property===prop)arr.push(keys[q]);arr.sort(function(a,b){return a.frame-b.frame;});if(!arr.length)return initial;if(frame<=arr[0].frame)return Number(arr[0].value);for(var q=1;q<arr.length;q++)if(frame<=arr[q].frame){var ratio=(frame-arr[q-1].frame)/(arr[q].frame-arr[q-1].frame);return Number(arr[q-1].value)+(Number(arr[q].value)-Number(arr[q-1].value))*ratio;}return Number(arr[arr.length-1].value);}
   for(var frame in positionFrames)tr.property('ADBE Position').setValueAtTime((offset+Number(frame))/data.motion.fps,[axisAt('x',Number(frame),e.x)+e.w/2,axisAt('y',Number(frame),e.y)+e.h/2]);
  }offset+=scene.durationFrames;
 }
 if(data.motion.audioAssetId&&assets[data.motion.audioAssetId]){var audio=comp.layers.add(assets[data.motion.audioAssetId]);audio.name='Soundtrack';audio.startTime=0;audio.outPoint=Math.min(comp.duration,audio.source.duration);var volume=typeof data.motion.volume==='number'?data.motion.volume:.8;var db=volume>0?20*Math.log(volume)/Math.LN10:-192;audio.property('ADBE Audio Group').property('ADBE Audio Levels').setValue([db,db]);}
 var captions=data.motion.captions||[];for(var c=0;c<captions.length;c++){var caption=captions[c],layer=comp.layers.addBoxText([comp.width*.8,comp.height*.14],caption.text);layer.inPoint=caption.start;layer.outPoint=Math.min(comp.duration,caption.end);layer.position.setValue([comp.width*.1,comp.height*.83]);}
 comp.openInViewer();alert('가져오기 완료. manifest.json의 글꼴·효과·색 관리 항목을 확인하세요.');
 }finally{app.endUndoGroup();}
})();
`;

const blenderScript = String.raw`"""Design Studio import: Blender Scripting > Open > Run Script. Adds a new scene; preserves existing scenes."""
import bpy, json, math
from pathlib import Path
root=Path(__file__).resolve().parent
data=json.loads((root/'scene.json').read_text(encoding='utf-8'))
m=data['motion']; tokens=data['tokens']; unit=.01
def color(value, fallback):
    if value and value.startswith('{'): value=tokens.get(value[1:-1],fallback)
    value=value or fallback
    channels=[int(value[n:n+2],16)/255 for n in (1,3,5)]
    return tuple(c/12.92 if c<=.04045 else ((c+.055)/1.055)**2.4 for c in channels)+(1,)
scene=bpy.data.scenes.new(data['name'])
if bpy.context.window: bpy.context.window.scene=scene
scene.render.resolution_x=m['width']; scene.render.resolution_y=m['height']; scene.render.resolution_percentage=100
scene.render.fps=m['fps']; scene.frame_start=1; scene.frame_end=sum(s['durationFrames'] for s in m['scenes'])
scene.render.film_transparent=m.get('transparent',False)
scene.view_settings.view_transform='Standard'; scene.view_settings.exposure=0; scene.view_settings.gamma=1
try: scene.view_settings.look='None'
except: pass
try: scene.render.engine='BLENDER_EEVEE_NEXT'
except: scene.render.engine='BLENDER_EEVEE'
world=bpy.data.worlds.new('Studio World'); scene.world=world; world.use_nodes=True; world.node_tree.nodes['Background'].inputs[0].default_value=color(tokens['color.bg'], '#000000')
camera_data=bpy.data.cameras.new('Studio Camera'); camera=bpy.data.objects.new('Studio Camera',camera_data);scene.collection.objects.link(camera);scene.camera=camera
camera.location=(m['width']*unit/2,-m['height']*unit/2,100);camera_data.type='ORTHO';camera_data.ortho_scale=m['width']*unit;camera_data.sensor_fit='HORIZONTAL'
assets={a['id']:a for a in data['assets']}
def material(name,rgba,opacity=1,image=None):
    mat=bpy.data.materials.new(name);mat.use_nodes=True;n=mat.node_tree.nodes;n.clear();links=mat.node_tree.links
    out=n.new('ShaderNodeOutputMaterial');emission=n.new('ShaderNodeEmission');emission.inputs['Color'].default_value=rgba
    transparent=n.new('ShaderNodeBsdfTransparent');mix=n.new('ShaderNodeMixShader');mix.inputs[0].default_value=opacity
    links.new(transparent.outputs[0],mix.inputs[1]);links.new(emission.outputs[0],mix.inputs[2]);links.new(mix.outputs[0],out.inputs['Surface'])
    if image:
        texture=n.new('ShaderNodeTexImage');texture.image=bpy.data.images.load(str(root/image['relativePath']),check_existing=True)
        if image['mime'].startswith('video/'):
            texture.image.source='MOVIE';texture.image_user.use_auto_refresh=True;texture.image_user.frame_duration=scene.frame_end
        texture.image.colorspace_settings.name='sRGB';links.new(texture.outputs['Color'],emission.inputs['Color'])
        multiply=n.new('ShaderNodeMath');multiply.operation='MULTIPLY';multiply.inputs[1].default_value=opacity;links.new(texture.outputs['Alpha'],multiply.inputs[0]);links.new(multiply.outputs[0],mix.inputs[0])
    if hasattr(mat,'surface_render_method'):mat.surface_render_method='DITHERED'
    elif hasattr(mat,'blend_method'):mat.blend_method='BLEND'
    return mat,mix
def quad(name,w,h,ellipse=False):
    if ellipse:
        vertices=[(math.cos(i*math.tau/64)*w/2,math.sin(i*math.tau/64)*h/2,0) for i in range(64)];faces=[tuple(range(64))]
    else:vertices=[(-w/2,-h/2,0),(w/2,-h/2,0),(w/2,h/2,0),(-w/2,h/2,0)];faces=[(0,1,2,3)]
    mesh=bpy.data.meshes.new(name);mesh.from_pydata(vertices,[],faces);mesh.update();obj=bpy.data.objects.new(name,mesh);scene.collection.objects.link(obj)
    uv=mesh.uv_layers.new(name='UVMap')
    for loop in mesh.loops: v=mesh.vertices[loop.vertex_index].co;uv.data[loop.index].uv=(v.x/w+.5,v.y/h+.5)
    return obj
if not m.get('transparent'):
    bg=quad('Background',m['width']*unit,m['height']*unit);bg.location=(m['width']*unit/2,-m['height']*unit/2,-1);bg.data.materials.append(material('Background',color(tokens['color.bg'],'#000000'))[0])
offset=0
for s in m['scenes']:
    for index,e in enumerate(s['elements']):
        kind=e['type'];obj=None;image=None
        if kind=='text':
            curve=bpy.data.curves.new(e['id'],'FONT');curve.body=e.get('text','');curve.size=e.get('fontSize',36)*unit;curve.space_line=float(tokens['font.lineHeight']);curve.align_x='LEFT';curve.align_y='TOP_BASELINE';curve.extrude=0
            obj=bpy.data.objects.new(e['id'],curve);scene.collection.objects.link(obj)
        elif kind in ('shape','image','video'):
            if kind in ('image','video'):
                image=assets.get(e.get('assetId'))
                if not image:continue
            obj=quad(e['id'],e['w']*unit,e['h']*unit,e.get('shape')=='ellipse')
        if obj is None:continue
        is_text=kind=='text';dx=0 if is_text else e['w']/2;dy=e.get('fontSize',36) if is_text else e['h']/2
        obj.location=((e['x']+dx)*unit,-(e['y']+dy)*unit,index*.001);obj.rotation_euler.z=-math.radians(e.get('rotation',0))
        mat,mix=material(e['id'],color(e.get('color') if is_text else e.get('fill'),tokens['color.text'] if is_text else tokens['color.accent']),e.get('opacity',1),image);obj.data.materials.append(mat)
        start=offset+e.get('startFrame',0)+1;end=offset+min(s['durationFrames'],e.get('endFrame',s['durationFrames']))
        for frame,hidden in [(1,True),(max(1,start-1),True),(start,False),(end,False),(end+1,True)]:
            obj.hide_render=hidden;obj.hide_viewport=hidden;obj.keyframe_insert('hide_render',frame=frame);obj.keyframe_insert('hide_viewport',frame=frame)
        if image and image['mime'].startswith('video/'):
            for node in mat.node_tree.nodes:
                if node.type=='TEX_IMAGE':node.image_user.frame_start=offset+1
        for key in sorted(e.get('keyframes',[]),key=lambda k:k['frame']):
            frame=offset+key['frame']+1;value=key['value'];prop=key['property']
            if prop=='x':obj.location.x=(float(value)+dx)*unit;obj.keyframe_insert('location',index=0,frame=frame)
            elif prop=='y':obj.location.y=-(float(value)+dy)*unit;obj.keyframe_insert('location',index=1,frame=frame)
            elif prop=='rotation':obj.rotation_euler.z=-math.radians(float(value));obj.keyframe_insert('rotation_euler',index=2,frame=frame)
            elif prop=='scale':obj.scale=(float(value),float(value),1);obj.keyframe_insert('scale',frame=frame)
            elif prop=='opacity' and not image:mix.inputs[0].default_value=float(value);mix.inputs[0].keyframe_insert('default_value',frame=frame)
        if obj.animation_data and obj.animation_data.action:
            try:
                for curve in obj.animation_data.action.fcurves:
                    for key in curve.keyframe_points:key.interpolation='CONSTANT' if 'hide_' in curve.data_path else 'LINEAR'
            except AttributeError:pass
    offset+=s['durationFrames']
scene.frame_set(1)
print('Design Studio import complete. Review manifest.json; save .blend manually.')
`;

export async function exportAdapter(
  project: Project,
  context: ExportContext,
  format: 'after-effects' | 'blender',
): Promise<ExportResult> {
  const dir = await prepareOutput(context, format);
  const zip = new JSZip();
  const assets = await addAssets(zip, project, context);
  const clean = safeProject(project);
  const design = resolveDesign(project, 'motion');
  const losses: Loss[] = [];
  for (const scene of project.motion.scenes) {
    if (scene.effectSettings)
      losses.push({
        location: scene.id,
        feature: '장면 효과 파라미터',
        capability: 'unsupported',
        message:
          'durationFrames·intensity·direction·delayFrames·easing은 scene.json에 보존하지만 대상 프로그램 효과로 적용하지 않습니다.',
      });
    if (scene.effect && scene.effect !== 'none')
      losses.push({
        location: scene.id,
        feature: `장면 효과: ${scene.effect}`,
        capability: 'unsupported',
        message:
          '효과 플러그인·장면 전환은 변환하지 않습니다. 수동 키프레임만 아래 범위에서 적용합니다.',
      });
    for (const e of scene.elements) {
      let cap: Loss['capability'] = 'native',
        message = '별도 편집 가능한 기본 레이어/개체로 가져옵니다.';
      if (['chart', 'table'].includes(e.type)) {
        cap = 'unsupported';
        message = '차트·표는 scene.json 원본에 보존되며 대상 장면에는 생성하지 않습니다.';
      } else if (
        (e.type === 'image' || e.type === 'video') &&
        !project.assets.some((a) => a.id === e.assetId)
      ) {
        cap = 'unsupported';
        message = '연결된 자산이 없어 생성하지 않습니다.';
      } else if (format === 'blender' && e.type === 'text') {
        cap = 'approximated';
        message =
          '편집 가능한 Blender Text입니다. 번들 기본 글꼴을 사용하며 한글 글리프·박스 줄바꿈을 위해 적법한 TTF/OTF를 직접 지정해야 합니다.';
      } else if (format === 'blender' && ['image', 'video'].includes(e.type)) {
        cap = 'approximated';
        message =
          'UV 텍스처 평면으로 가져옵니다. 코덱과 색 변환, 이미지 투명도·opacity 키프레임은 별도 확인이 필요합니다.';
      }
      losses.push({
        location: scene.id,
        elementId: e.id,
        feature: e.type,
        capability: cap,
        message,
      });
      if (e.keyframes?.length)
        losses.push({
          location: scene.id,
          elementId: e.id,
          feature: '키프레임',
          capability: 'approximated',
          message:
            '위치·회전·배율 및 기본 요소 투명도를 선형 보간합니다. easing·색상 키프레임과 Blender 영상 투명도 키프레임은 변환하지 않습니다.',
        });
      if (e.effect)
        losses.push({
          location: scene.id,
          elementId: e.id,
          feature: e.effect,
          capability: 'unsupported',
          message: '편집기 효과 프리셋은 대상 프로그램에서 다시 설정해야 합니다.',
        });
      if (e.effectSettings)
        losses.push({
          location: scene.id,
          elementId: e.id,
          feature: '요소 효과 파라미터',
          capability: 'unsupported',
          message:
            '효과 길이·강도·방향·지연·이징 설정은 원본 데이터에 보존되며 대상 레이어 효과로 변환하지 않습니다.',
        });
    }
  }
  losses.push({
    location: 'color',
    feature: '색 관리',
    capability: 'approximated',
    message:
      format === 'blender'
        ? 'sRGB 값을 선형 RGB로 변환하고 Emission + Standard view를 설정합니다. 색 프로파일과 디스플레이까지 동일하게 재현한다고 보장하지 않습니다.'
        : 'sRGB 채널값을 레이어에 적용합니다. After Effects 작업 색 공간은 기존 프로젝트 설정을 유지하므로 직접 확인하세요.',
  });
  if (format === 'blender' && (project.motion.audioAssetId || project.motion.captions?.length))
    losses.push({
      location: 'motion',
      feature: '오디오·자막',
      capability: 'unsupported',
      message:
        '자산 및 scene.json 데이터는 포함되지만 Blender 타임라인 오디오·자막 레이어는 생성하지 않습니다.',
    });
  if (
    project.motion.audioTrimStartFrames ||
    project.motion.audioTrimEndFrames !== undefined ||
    project.motion.audioFadeInFrames ||
    project.motion.audioFadeOutFrames
  )
    losses.push({
      location: 'motion',
      feature: '오디오 트림·페이드',
      capability: 'unsupported',
      message:
        '소스 트림과 페이드 프레임은 scene.json에 보존합니다. 가져오기 스크립트에서 적용하지 않으므로 대상 프로그램에서 다시 설정해야 합니다.',
    });
  const sceneData = {
    schemaVersion: 1,
    name: project.name,
    font: project.brand.font,
    tokens: design.tokens,
    motion: clean.motion,
    assets: clean.assets.map((a) => ({
      ...a,
      relativePath: assets.find((f) => f.id === a.id)!.path,
    })),
  };
  zip.file('scene.json', JSON.stringify(sceneData, null, 2));
  zip.file(
    format === 'after-effects' ? 'import-scene.jsx' : 'import_scene.py',
    format === 'after-effects' ? aeScript : blenderScript,
  );
  const manifest = await writeManifest(dir, project, format, losses, {
    assets,
    generatedProjectFile: false,
    note: '스크립트와 JSON 패키지입니다. .aep 또는 .blend 바이너리 파일을 생성하지 않았습니다. 대상 프로그램에서 실행하고 저장하세요.',
  });
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  zip.file(
    'README.md',
    `# ${project.name} — ${format}\n\nZIP 전체를 한 폴더에 풉니다. ${format === 'after-effects' ? 'After Effects의 File > Scripts > Run Script File에서 import-scene.jsx를 선택합니다.' : 'Blender Scripting에서 import_scene.py를 열고 Run Script를 실행합니다.'} 기존 작업을 삭제하지 않고 새 ${format === 'after-effects' ? '컴포지션' : '씬'}을 추가합니다.\n\n이 파일은 자동 실행되지 않습니다. 대상 프로그램이 설치되어 있어야 합니다. 입력 JSON은 데이터로 읽으며 사용자 텍스트를 코드로 실행하지 않습니다. 설치된 대상 프로그램에서의 실행 검증은 아직 하지 않았습니다.\n\nmanifest.json의 요소별 변환 가능 범위를 확인하세요. 프리셋 효과, 표·차트, 색 키프레임은 자동 변환하지 않습니다. 기본 텍스트·도형과 위치·회전·배율 키프레임이 편집 가능한 형태로 전달됩니다.\n\n글꼴 파일은 포함하지 않습니다. ${format === 'blender' ? 'Blender 기본 글꼴은 한글을 지원하지 않을 수 있습니다. Text 개체의 Font를 적법한 한글 TTF/OTF로 직접 설정하고 줄바꿈을 조정하세요.' : '글꼴 이름이 대상 시스템과 일치하는지 확인하고 줄바꿈을 점검하세요.'} 이미지·영상은 패키지 내 assets/에서 불러옵니다.\n`,
  );
  const name = slug(project.name) + `-${format}.zip`;
  await writeFile(
    path.join(dir, name),
    await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
  );
  return result(dir, [{ name, mime: 'application/zip' }], manifest);
}
