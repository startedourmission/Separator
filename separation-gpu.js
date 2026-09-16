import { getColorLUT, LUT_SIZE } from './color-profile.js';
import { getSpotColorRGB } from './constants.js';

const vertex = `#version 300 es
out vec2 uv;
void main(){
    vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);
    uv=vec2(p.x,1.0-p.y);
    gl_Position=vec4(p*2.0-1.0,0,1);
}`;
const fragment = `#version 300 es
precision highp float;
precision highp sampler3D;
precision highp sampler2DArray;
in vec2 uv;
out vec4 color;
uniform sampler2D process;
uniform sampler2DArray spots;
uniform sampler3D profile;
uniform vec4 mask;
uniform vec4 equivalents[10];
uniform vec3 fallback[10];
uniform int modes[10];
uniform int count;
uniform float inkLimit;
void main(){
    vec4 ink=texture(process,uv)*mask;
    vec3 multiplier=vec3(1);
    for(int i=0;i<10;i++) {
        if(i>=count) break;
        float tint=texture(spots,vec3(uv,float(i))).r;
        if(modes[i]==1) ink+=tint*equivalents[i];
        if(modes[i]==2) multiplier*=mix(vec3(1),fallback[i],tint);
    }
    ink=clamp(ink,0.,1.);
    // Match 8-bit plate input to the exact CPU transform.
    ink=floor(ink*255.+.5)/255.;
    float n=${LUT_SIZE}.;
    vec4 t=ink*(n-1.);
    float k=floor(t.w);
    vec2 xy=(t.xy+.5)/n;
    vec3 a=texture(profile,vec3(xy,(t.z+.5+k*n)/(n*n))).rgb;
    vec3 b=texture(profile,vec3(xy,(t.z+.5+min(k+1.,n-1.)*n)/(n*n))).rgb;
    vec3 linear=mix(a,b,fract(t.w));
    vec3 rgb=mix(12.92*linear,1.055*pow(max(linear,vec3(0)),vec3(1./2.4))-.055,step(vec3(.0031308),linear));
    color=vec4(rgb*multiplier,1);
    if(inkLimit>0.) {
        ivec2 size=textureSize(process,0);
        ivec2 pixel=clamp(ivec2(uv*vec2(size)),ivec2(0),size-1);
        float total=dot(floor(texelFetch(process,pixel,0)*255.+.5),vec4(1));
        for(int i=0;i<10;i++) {
            if(i>=count) break;
            total+=floor(texelFetch(spots,ivec3(pixel,i),0).r*255.+.5);
        }
        if(total*100.>inkLimit*255.) color=vec4(1.,35./255.,35./255.,1.);
    }
}`;

// One shared GL context. Source textures survive separation toggles. Canvas copies
// preserve the viewer's existing 2D API (cursor, export, comparison and tests).
export class SeparationGPU {
    constructor(maxBytes=256*1024*1024) {
        this.maxBytes=maxBytes;
        this.bytes=0;
        this.pages=new Map();
        this.canvas=document.createElement('canvas');
        const gl=this.canvas.getContext('webgl2',{alpha:false,antialias:false,preserveDrawingBuffer:true});
        if(!gl) throw new Error('WebGL2 unavailable');
        this.gl=gl;
        this.canvas.addEventListener('webglcontextlost', e=>{e.preventDefault();this.lost=true;this.clear();});
        const shader=(type,source)=>{
            const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);
            if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
            return s;
        };
        this.program=gl.createProgram();
        const v=shader(gl.VERTEX_SHADER,vertex),f=shader(gl.FRAGMENT_SHADER,fragment);
        gl.attachShader(this.program,v);gl.attachShader(this.program,f);gl.linkProgram(this.program);
        gl.deleteShader(v);gl.deleteShader(f);
        if(!gl.getProgramParameter(this.program,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.program));
        gl.useProgram(this.program);
        this.uniform=Object.fromEntries(['process','spots','profile','mask','equivalents[0]','fallback[0]','modes[0]','count','inkLimit']
            .map(n=>[n,gl.getUniformLocation(this.program,n)]));
        gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
        this.profile=gl.createTexture();gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_3D,this.profile);
        if(gl.getParameter(gl.MAX_3D_TEXTURE_SIZE)<LUT_SIZE*LUT_SIZE) throw new Error('ICC texture exceeds device limit');
        gl.texImage3D(gl.TEXTURE_3D,0,gl.RGB16F,LUT_SIZE,LUT_SIZE,LUT_SIZE*LUT_SIZE,0,gl.RGB,gl.FLOAT,getColorLUT());
        this.parameters(gl.TEXTURE_3D,gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_WRAP_R,gl.CLAMP_TO_EDGE);
        gl.disable(gl.DITHER);
        gl.uniform1i(this.uniform.process,0);gl.uniform1i(this.uniform.spots,1);gl.uniform1i(this.uniform.profile,2);
    }
    parameters(target,filter) {
        const gl=this.gl;
        gl.texParameteri(target,gl.TEXTURE_MIN_FILTER,filter);gl.texParameteri(target,gl.TEXTURE_MAG_FILTER,filter);
        gl.texParameteri(target,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(target,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    }
    source(data,spotData,background) {
        if(this.pages.has(data)) {
            const item=this.pages.get(data);this.pages.delete(data);this.pages.set(data,item);return item;
        }
        const gl=this.gl,{width,height,channels}=data;
        const names=Object.keys(spotData||{});
        if(names.length>10 || Math.max(width,height)>gl.getParameter(gl.MAX_TEXTURE_SIZE)) return null;
        const n=width*height,bytes=n*(4+names.length)+(!names.length?1:0);
        if(bytes>this.maxBytes) return null;
        // Preparing the hidden overprint screen must not evict the visible
        // screen's source textures. Use a temporary upload if it won't fit.
        const temporary=background && this.bytes+bytes>this.maxBytes;
        if(!temporary) while(this.bytes+bytes>this.maxBytes && this.pages.size) this.release(this.pages.keys().next().value);
        const packed=new Uint8Array(n*4);
        for(let i=0;i<n;i++) {
            packed[i*4]=channels.cyan[i];packed[i*4+1]=channels.magenta[i];
            packed[i*4+2]=channels.yellow[i];packed[i*4+3]=channels.black[i];
        }
        const process=gl.createTexture();gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,process);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,packed);
        this.parameters(gl.TEXTURE_2D,gl.LINEAR);
        const spots=gl.createTexture();gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D_ARRAY,spots);
        gl.texStorage3D(gl.TEXTURE_2D_ARRAY,1,gl.R8,names.length?width:1,names.length?height:1,Math.max(1,names.length));
        for(let i=0;i<names.length;i++) gl.texSubImage3D(gl.TEXTURE_2D_ARRAY,0,0,0,i,width,height,1,gl.RED,gl.UNSIGNED_BYTE,spotData[names[i]]);
        this.parameters(gl.TEXTURE_2D_ARRAY,gl.LINEAR);
        const item={process,spots,names,bytes,temporary};
        if(!temporary) {this.pages.set(data,item);this.bytes+=bytes;}
        return item;
    }
    render(canvas,data,spotData,separations,spotCMYK={},background=false,inkLimit=0) {
        if(this.lost || this.gl.isContextLost()) return false;
        const item=this.source(data,spotData,background);
        if(!item) return false;
        const gl=this.gl,{width,height}=canvas;
        if(this.canvas.width!==width || this.canvas.height!==height) {this.canvas.width=width;this.canvas.height=height;}
        gl.viewport(0,0,width,height);gl.useProgram(this.program);
        gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,item.process);
        gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D_ARRAY,item.spots);
        gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_3D,this.profile);
        const eq=new Float32Array(40),rgb=new Float32Array(30),modes=new Int32Array(10);
        item.names.forEach((name,i)=>{
            if(!separations.spotColors?.[name]) return;
            if(spotCMYK[name]) {modes[i]=1;eq.set(spotCMYK[name],i*4);}
            else {modes[i]=2;const {r,g,b}=getSpotColorRGB(name);rgb.set([r/255,g/255,b/255],i*3);}
        });
        gl.uniform4fv(this.uniform.mask,['cyan','magenta','yellow','black'].map(n=>separations[n]?1:0));
        gl.uniform4fv(this.uniform['equivalents[0]'],eq);gl.uniform3fv(this.uniform['fallback[0]'],rgb);
        gl.uniform1iv(this.uniform['modes[0]'],modes);gl.uniform1i(this.uniform.count,item.names.length);
        gl.uniform1f(this.uniform.inkLimit,inkLimit);
        gl.drawArrays(gl.TRIANGLES,0,3);
        if(item.temporary) {gl.deleteTexture(item.process);gl.deleteTexture(item.spots);}
        if(gl.getError()!==gl.NO_ERROR) {this.lost=true;this.clear();return false;}
        const ctx=canvas.getContext('2d');
        ctx.drawImage(this.canvas,0,0,width,height);
        return true;
    }
    release(data) {
        const item=this.pages.get(data);if(!item)return;
        this.gl.deleteTexture(item.process);this.gl.deleteTexture(item.spots);
        this.bytes-=item.bytes;this.pages.delete(data);
    }
    clear(){for(const data of this.pages.keys())this.release(data);}
}
