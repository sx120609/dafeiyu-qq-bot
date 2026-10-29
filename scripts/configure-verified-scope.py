"""Apply the initial, bounded roster configuration after QQ identity verification.

This is an explicit one-shot setup step, not an automatic roster expansion service.
Existing target choices are preserved. No messages are sent by this script.
"""
from supervisor import Panel, RUNTIME

panel = Panel((RUNTIME / 'control-url.txt').read_text())
state = panel.status()
if not state['connected']:
    raise RuntimeError('QQ identity must be verified before configuring recipients')
if state['running']:
    raise RuntimeError('Pause replies before initial configuration')
if state['config']['targets']:
    raise RuntimeError('Existing conversation choices are preserved; use the console to edit them')
contacts = state['contacts']
if not contacts or len(contacts) > 20:
    raise RuntimeError('Initial verified roster must contain 1 to 20 conversations')
for contact in contacts:
    panel.action('add', target=contact['key'])
state = panel.status()
panel.action('save', ai=state['config']['ai'], persona=state['persona'],
             enabled=[contact['key'] for contact in contacts],
             onlineEnabled=True, visionEnabled=True, memoryEnabled=True,
             groupParticipationEnabled=False)
verified = panel.status()
assert len([t for t in verified['config']['targets'] if t['enabled']]) == len(contacts)
assert verified['config']['groupParticipationEnabled'] is False
print({'privateConversations': sum(not c['group'] for c in contacts),
       'groupsMentionOnly': sum(c['group'] for c in contacts), 'proactiveGroupReplies': False,
       'messagesSentBySetup': 0})
