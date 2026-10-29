"""Apply the 大肥鱼 persona (personas/dafeiyu.txt) and the conversation limits to the running engine; replies keep running."""
from supervisor import Panel, RUNTIME, ROOT
panel=Panel((RUNTIME/'control-url.txt').read_text())
state=panel.status()
persona=dict(state['persona'])
# Up to 500 characters per reply, at most three messages when the model splits it with blank lines.
# Stickers only when a reply is strongly emotional and the model picked a fitting one; never on a
# fixed every-N-replies schedule, and at most one every ten minutes.
persona.update(style='custom',customName='大肥鱼',customPrompt=(ROOT/'personas/dafeiyu.txt').read_text(encoding='utf-8'),
               maxCharacters=500,banter=1,stickersEnabled=True,stickerIntervalSeconds=600,stickerEveryReplies=0)
ai=dict(state['config']['ai'])
ai.update(cooldownSeconds=2,maxTokens=2000,dailyLimit=1500)
limits=dict(ai.get('sendLimits') or {})
# A reply may now be several messages, so the send budget counts messages, not replies.
limits.update(daily=1500,perChatDaily=400,globalIntervalSeconds=1)
ai['sendLimits']=limits
panel.action('save',persona=persona,ai=ai,fastReplyEnabled=True,naturalRepliesEnabled=True,loopProtectionEnabled=True)
print('Folk persona and conversation limits applied.')
