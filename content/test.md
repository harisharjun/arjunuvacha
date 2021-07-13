---
title: "Test"
date: 2021-06-27T00:03:56+05:30
draft: true
---

* Added Favicon in layouts/partials/head/head.html
<link href="/favicon.png" rel="icon" type="image/x-icon" />

* Removed Footer from layouts/partials/footer/footer.html
* Added right sider bar {{ partialCached "sidebar/right.html" . }} in single.html which is in layouts/_default
* Added redirection <a href="/"> to the au icon in layouts/partials/siderbar/left.html