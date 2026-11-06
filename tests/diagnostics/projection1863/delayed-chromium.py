#!/usr/bin/python3
"""Diagnostic-only launch delay; never changes the media fixture's deadlines."""
import os
import sys
import time

seconds = float(os.environ.get('GUGU_TRACE_CHROMIUM_DELAY_SECONDS', '13'))
executable = os.environ['GUGU_TRACE_REAL_CHROMIUM']
sys.stderr.write(f'CONTROLLED_CHROMIUM_DELAY={seconds}\n')
sys.stderr.flush()
time.sleep(seconds)
os.execv(executable, [executable, *sys.argv[1:]])
