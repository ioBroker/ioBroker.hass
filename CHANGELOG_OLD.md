# Older changes
## 1.3.0 (2022-07-01)
* (Apollon77) Further optimize sending data to HASS and allow setting values like numbers as normal states if the service has one attribute and it can be mapped

[Older changelogs can be found there](CHANGELOG_OLD.md)## License
The MIT License (MIT)

Copyright (c) 2018-2026 bluefox <dogafox@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

## 1.2.0 (2022-06-17)
* (Apollon77) IMPORTANT: Replace special characters in entity attribute names with an underscore! Object IDs might change!
* (Apollon77) make sure a "null" value in state changes is not crashing

## 1.1.2 (2022-03-29)
* (Apollon77) Fix crash cases reported by Sentry

## 1.1.1 (2022-03-25)
* (Apollon77) Show password fields masked again in config

## 1.1.0 (2022-03-24)
* IMPORTANT: You need to re-enter the password once after installing this version!
* (Apollon77) Implement Service triggers to use any value to trigger or stringified JSON to call with fields
* (Apollon77) Optimize unload handling
* (Apollon7) Add Sentry for crash reporting

## 1.0.1 (2021-09-04)
* IMPORTANT: js-controller 2.0 is needed at least!
* (Apollon77) Fix start issue
* (Apollon77/Garfonso) Fix issue where value could not be set in hass

## 1.0.0 (2020-12-13)
* (bluefox) added the support of compact mode

## 0.1.0
* (bluefox) initial release
