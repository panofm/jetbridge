---
'jetbridge': patch
---

Fixes over-the-air delivery failing with "There are no current certificates on this team matching the provided certificate IDs compatible with IOS_APP_ADHOC profiles".

The certificate kind now follows the profile type: a development profile embeds a development certificate, ad hoc and in-house embed a distribution one. Requesting an ad hoc profile while looking up a development certificate is a pairing Apple rejects, with a 409 that reads like a missing certificate rather than the wrong kind of one.

`ota.exportMethod` gains `development`, and it is now the default. It produces an `.ipa` that installs over the air on every device named in the profile, signed with the certificate every Apple developer already has — where `ad-hoc` and `enterprise` need a distribution certificate the team may never have issued. When one is genuinely missing, the error now says which setting avoids needing it.
