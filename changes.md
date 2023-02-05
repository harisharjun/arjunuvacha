---
title: "Changes"
date: 2021-06-27T00:03:56+05:30
draft: true
---

* Added the custom styles sheet <link rel="stylesheet" href="../../styles.css"> in baseof.html under themes folder

* Added Favicon in layouts/partials/head/head.html
<link href="/favicon.png" rel="icon" type="image/x-icon" />

* 
* Added right sider bar {{ partialCached "sidebar/right.html" . }} in single.html which is in layouts/_default
* Added redirection <a href="/"> to the au icon in layouts/partials/siderbar/left.html

* Footer:
    In &:before { : display: inline-block;
    Removed Theme By content from layouts/partials/footer/footer.html
    In footer.site-footer { : text-align: center;

    <br>
        
        <div style="margin-top: 10px; display: block;"></div>
        <a href="https://www.linkedin.com/in/harisharjun/" target="_blank">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height=24 fill="currentColor" class="bi bi-linkedin" viewBox="0 0 16 16">
                <path d="M0 1.146C0 .513.526 0 1.175 0h13.65C15.474 0 16 .513 16 1.146v13.708c0 .633-.526 1.146-1.175 1.146H1.175C.526 16 0 15.487 0 14.854V1.146zm4.943 12.248V6.169H2.542v7.225h2.401zm-1.2-8.212c.837 0 1.358-.554 1.358-1.248-.015-.709-.52-1.248-1.342-1.248-.822 0-1.359.54-1.359 1.248 0 .694.521 1.248 1.327 1.248h.016zm4.908 8.212V9.359c0-.216.016-.432.08-.586.173-.431.568-.878 1.232-.878.869 0 1.216.662 1.216 1.634v3.865h2.401V9.25c0-2.22-1.184-3.252-2.764-3.252-1.274 0-1.845.7-2.165 1.193v.025h-.016a5.54 5.54 0 0 1 .016-.025V6.169h-2.4c.03.678 0 7.225 0 7.225h2.4z"/>
            </svg>
        </a>

        <div style="margin-right: 20px; display: inline-block;"></div>

        <a href="https://github.com/harisharjun" target="_blank">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" class="bi bi-github" viewBox="0 0 16 16">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
            </svg>
        </a>

        <div style="margin-right: 20px; display: inline-block;"></div>

        <a href="https://twitter.com/arjunuvacha_" target="_blank">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" class="bi bi-twitter" viewBox="0 0 16 16">
                <path d="M5.026 15c6.038 0 9.341-5.003 9.341-9.334 0-.14 0-.282-.006-.422A6.685 6.685 0 0 0 16 3.542a6.658 6.658 0 0 1-1.889.518 3.301 3.301 0 0 0 1.447-1.817 6.533 6.533 0 0 1-2.087.793A3.286 3.286 0 0 0 7.875 6.03a9.325 9.325 0 0 1-6.767-3.429 3.289 3.289 0 0 0 1.018 4.382A3.323 3.323 0 0 1 .64 6.575v.045a3.288 3.288 0 0 0 2.632 3.218 3.203 3.203 0 0 1-.865.115 3.23 3.23 0 0 1-.614-.057 3.283 3.283 0 0 0 3.067 2.277A6.588 6.588 0 0 1 .78 13.58a6.32 6.32 0 0 1-.78-.045A9.344 9.344 0 0 0 5.026 15z"/>
            </svg>
        </a>

        <div style="margin-right: 20px; display: inline-block;"></div>

        <a href="https://www.instagram.com/arjunuvacha" target="_blank">
            <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" height="24" width="24" viewBox="0 -8 62 67"><defs><linearGradient id="a" y2="1.7526" x2="1.7537" y1="-5.8041" x1="-5.8093"><stop offset="0%" stop-color="#34485E"/><stop offset="5%" stop-color="#34485E"/><stop offset="50.1119%" stop-color="#34485E"/><stop offset="95%" stop-color="#34485E"/><stop offset="95.0079%" stop-color="#34485E"/><stop offset="100%" stop-color="#34485E"/></linearGradient><linearGradient id="b" y2=".9175" x2=".9175" y1=".0091" x1=".009"><stop offset="0%" stop-color="#34485E"/><stop offset="5%" stop-color="#34485E"/><stop offset="50.1119%" stop-color="#34485E"/><stop offset="95%" stop-color="#34485E"/><stop offset="95.0079%" stop-color="#34485E"/><stop offset="100%" stop-color="#34485E"/></linearGradient><linearGradient id="c" y2="1.3128" x2="1.3126" y1="-.456" x1="-.4558"><stop offset="0%" stop-color="#34485E"/><stop offset="5%" stop-color="#34485E"/><stop offset="50.1119%" stop-color="#34485E"/><stop offset="95%" stop-color="#34485E"/><stop offset="95.0079%" stop-color="#34485E"/><stop offset="100%" stop-color="#34485E"/></linearGradient><linearGradient gradientUnits="userSpaceOnUse" gradientTransform="scale(1.00041 .99959)" y2="11.412" x2="11.3667" y1="-37.5455" x1="-37.6312" id="d" xlink:href="#a"/><linearGradient gradientUnits="userSpaceOnUse" y2="49.554" x2="49.5047" y1=".536" x1=".4867" id="e" xlink:href="#b"/><linearGradient gradientUnits="userSpaceOnUse" gradientTransform="scale(.99988 1.00012)" y2="36.4816" x2="36.4315" y1="-12.5305" x1="-12.5688" id="f" xlink:href="#c"/></defs><g fill="none"><path d="M6.4867 3.292c0 1.7933-1.4534 3.2413-3.24 3.2413C1.46 6.5333.0053 5.0853.0053 3.292.0053 1.5053 1.46.0573 3.2467.0573c1.7866 0 3.24 1.448 3.24 3.2347" fill="url(#d)" transform="matrix(1 0 0 -1 38.1333 15.8707)"/><path d="M48.9373 16.124c-.12-2.6307-.56-4.06-.9253-5.0093-.4907-1.2587-1.076-2.1587-2.0253-3.1027-.9387-.944-1.8387-1.528-3.0974-2.0133-.9493-.3707-2.384-.812-5.0146-.9374-2.844-.1253-3.6867-.152-10.8987-.152-7.2053 0-8.0547.0267-10.8987.152-2.6306.1254-4.0586.5667-5.008.9374C9.804 6.484 8.9107 7.068 7.9667 8.012c-.9507.944-1.536 1.844-2.02 3.1027-.3654.9493-.812 2.3786-.9254 5.0093-.1386 2.844-.164 3.7-.164 10.8973 0 7.212.0254 8.0614.164 10.9054.1134 2.6306.56 4.0586.9254 5.016.484 1.2573 1.0693 2.152 2.02 3.096.944.9426 1.8373 1.528 3.1026 2.0186.9494.372 2.3774.8067 5.008.932 2.844.1254 3.6934.1574 10.8987.1574 7.212 0 8.0547-.032 10.8987-.1574 2.6306-.1253 4.0653-.56 5.0146-.932 1.2587-.4906 2.1587-1.076 3.0974-2.0186.9493-.944 1.5346-1.8387 2.0253-3.096.3653-.9574.8053-2.3854.9253-5.016.132-2.844.164-3.6934.164-10.9054 0-7.1973-.032-8.0533-.164-10.8973zm4.8574 22.024c-.132 2.8747-.5854 4.8387-1.2587 6.5493-.6853 1.7747-1.604 3.2787-3.108 4.7827-1.4973 1.4973-3.0013 2.416-4.776 3.1093-1.7173.6667-3.6747 1.1254-6.5507 1.2507-2.876.1387-3.7946.164-11.1253.164-7.324 0-8.2493-.0253-11.1253-.164-2.8694-.1253-4.8254-.584-6.5507-1.2507-1.768-.6933-3.272-1.612-4.7693-3.1093-1.504-1.504-2.4227-3.008-3.1147-4.7827C.7493 42.9867.296 41.0227.1573 38.148.032 35.272 0 34.352 0 27.0213c0-7.324.032-8.2426.1573-11.1186.1387-2.8694.592-4.832 1.2587-6.5507.692-1.768 1.6107-3.2787 3.1147-4.776C6.028 3.0787 7.532 2.1533 9.3 1.4613c1.7253-.6666 3.6813-1.12 6.5507-1.252 2.876-.132 3.8013-.164 11.1253-.164 7.3307 0 8.2493.032 11.1253.164 2.876.132 4.8334.5854 6.5507 1.252 1.7747.692 3.2787 1.6174 4.776 3.1147 1.504 1.4973 2.4227 3.008 3.108 4.776.6733 1.7187 1.1267 3.6813 1.2587 6.5507.132 2.876.164 3.7946.164 11.1186 0 7.3307-.032 8.2507-.164 11.1267z" fill="url(#e)" transform="matrix(1 0 0 -1 0 54.004)"/><path d="M13.9093 4.9693c-4.964 0-8.992 4.0214-8.992 8.9854 0 4.972 4.028 8.9986 8.992 8.9986 4.9654 0 8.9987-4.0266 8.9987-8.9986 0-4.964-4.0333-8.9854-8.9987-8.9854zm0 22.848C6.2573 27.8173.06 21.6067.06 13.9547.06 6.3093 6.2573.1053 13.9093.1053c7.652 0 13.856 6.204 13.856 13.8494 0 7.652-6.204 13.8626-13.856 13.8626z" fill="url(#f)" transform="matrix(1 0 0 -1 13.0667 40.9373)"/></g></svg>
        </a>

        <div style="margin-right: 20px; display: inline-block;"></div>

        <a href="mailto:k.harisharjun@gmail.com">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" class="bi bi-envelope-fill" viewBox="0 0 16 16">
                <path d="M.05 3.555A2 2 0 0 1 2 2h12a2 2 0 0 1 1.95 1.555L8 8.414.05 3.555zM0 4.697v7.104l5.803-3.558L0 4.697zM6.761 8.83l-6.57 4.027A2 2 0 0 0 2 14h12a2 2 0 0 0 1.808-1.144l-6.57-4.027L8 9.586l-1.239-.757zm3.436-.586L16 11.801V4.697l-5.803 3.546z"/>
            </svg>
        </a>
