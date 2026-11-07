# TracingInsights native pet — third-party notices

The `ti-pet` binary in this folder is built by the
[TracingInsights/petdex](https://github.com/TracingInsights/petdex) fork
(`packages/ti-pet`, docs/DESKTOP_PETS_NATIVE_PLAN.md N5). It contains:

| Component                                                                                                                             | License    | Text                     |
| ------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------ |
| Petdex (`crafter-station/petdex`, forked as `TracingInsights/petdex`) — Copyright (c) 2026 Crafter Station                            | MIT        | `LICENSE-petdex.txt`     |
| Native SDK (`Railly/native` @ `c0b10d027efa490fc99a3bc7f1cf88b015999d45`, branch `feat/floating-window-0.5.3`, with Petdex's patches) | Apache-2.0 | `LICENSE-native-sdk.txt` |

The Native SDK ships no `NOTICE` file at that commit. `ti-pet` declares no
web views, so the SDK's vendored WebView2 loader is not linked or shipped.
On Linux the binary links the system's GTK 4 and libX11 dynamically; they
are not distributed with it.
