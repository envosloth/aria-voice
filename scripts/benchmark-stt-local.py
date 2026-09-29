#!/usr/bin/env python3
"""Repeatable CPU comparison, synthetic British speech; not a human/noise test.
Writes every transcript, elapsed time and WER to a JSON artifact in TMPDIR.
Run sequentially: python3 scripts/benchmark-stt-local.py MODEL [AUDIO_CTX]
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import statistics
import subprocess
import sys
import time
import wave

root = Path(__file__).resolve().parent.parent
scratch = Path(os.environ['TMPDIR']) / 'aria-stt-comparison'
scratch.mkdir(exist_ok=True)
models = Path.home() / '.local/share/aria/models'
phrases = [
    'What is the weather in Longmont, Colorado?',
    'Open Blender and start a new animation project.',
    'Remember that I prefer short answers.',
    'Set a timer for five minutes.',
    'Please explain the selected text in simple English.',
    'Can you tell me whether that approach will work?',
    'Aria, cancel that and listen to me.',
    'My next video is about a robot learning to cook.'
]

def words(s): return re.findall(r'[a-z0-9]+', s.lower())
def wer(expected, got):
    a,b=words(expected),words(got);row=list(range(len(b)+1))
    for i,x in enumerate(a,1):
        nextrow=[i]
        for j,y in enumerate(b,1): nextrow.append(min(nextrow[-1]+1,row[j]+1,row[j-1]+(x!=y)))
        row=nextrow
    return row[-1],len(a)

for i,text in enumerate(phrases):
    raw=scratch/f'{i}-raw.wav'; out=scratch/f'{i}.wav'
    if not out.exists():
        subprocess.run([str(root/'sidecars/tts/venv/bin/python'),'-m','piper','-m',str(models/'en_GB-alan-medium.onnx'),'-f',str(raw)],input=text.encode(),check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        subprocess.run(['ffmpeg','-y','-i',str(raw),'-ar','16000','-ac','1',str(out)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)

model=sys.argv[1];ctx=sys.argv[2] if len(sys.argv)>2 else '1'
os.environ.update(ARIA_STT_PROVIDER='local',ARIA_STT_BACKEND='cpu',ARIA_STT_THREADS='2',ARIA_STT_MODEL=model,ARIA_STT_AUDIO_CTX=ctx)
spec=importlib.util.spec_from_file_location('bench_stt',root/'sidecars/stt/main.py')
assert spec and spec.loader
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
s=m.SttSidecar();s.emit=lambda msg: print(json.dumps(msg),flush=True)
rows=[]
try:
    start=time.perf_counter();s.initialize();initial_ms=round((time.perf_counter()-start)*1000)
    if not s._server_proc or s._server_proc.poll() is not None:raise RuntimeError('warm server unavailable')
    for i,text in enumerate(phrases):
        with wave.open(str(scratch/f'{i}.wav'),'rb') as f:pcm=f.readframes(f.getnframes())
        start=time.perf_counter();actual=s._transcribe(pcm);ms=round((time.perf_counter()-start)*1000)
        errors,total=wer(text,actual)
        row={'expected':text,'actual':actual,'ms':ms,'word_errors':errors,'words':total}
        rows.append(row);print(json.dumps(row),flush=True)
    result={'model':model,'audio_ctx':ctx,'prompt':os.environ.get('ARIA_STT_PROMPT',''),'threads':2,'fixture':'Piper en_GB-alan-medium, clean synthetic speech, 8 utterances','initialization_ms':initial_ms,'median_stt_ms':statistics.median(r['ms'] for r in rows),'wer':sum(r['word_errors'] for r in rows)/sum(r['words'] for r in rows),'rows':rows}
    dest=scratch/f'{model}-ctx{ctx}{"-prompt" if os.environ.get("ARIA_STT_PROMPT") else ""}.json';dest.write_text(json.dumps(result,indent=2))
    print('RESULT '+json.dumps({k:v for k,v in result.items() if k!='rows'})+' artifact='+str(dest),flush=True)
finally:s.cleanup()
