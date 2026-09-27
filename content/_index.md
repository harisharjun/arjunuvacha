---
# The home page: a comic-strip story about the blog, then two ways in.
# Rendered by layouts/index.html. Images live in assets/img/web_images and
# assets/img/mobile_images, named arjun_uvacha_panel_NN.png.
#
# `wide: true` panels take a whole row on a computer; the others pair up two to
# a row, in order. On a phone every panel gets its own row, using the mobile file.
# `alt` is what a screen reader says, so it carries the words in the picture.
landing:
  panels:
    - panel: 1
      alt: >-
        Arjun at his desk late at night, surrounded by books labelled Product, Tech,
        People and Growth, with a mug that says Curious Always. He thinks: so many
        questions. Users? Problem? Solution? Build? Measure? What next?
    - panel: 2
      alt: >-
        Arjun with his backpack at a signpost pointing to Users, Product, Team,
        Career, Life and Purpose. He thinks: time to find some answers!
    - panel: 3
      wide: true
      alt: >-
        On a hilltop at sunset, Krishna says to Arjun: Good questions, Arjun.
        Let's think together.
    - panel: 4
      alt: >-
        On the way, I meet many Krishnas. The User Krishna asks: What do users
        really need?
    - panel: 5
      alt: "The Mentor Krishna says: Focus on the real problem."
    - panel: 6
      alt: "The Team Krishna says: Ship. Learn. Iterate."
    - panel: 7
      alt: "The Life Krishna says: Balance matters too."
    - panel: 8
      wide: true
      alt: "The Purpose Krishna says: Zoom out. What's the larger impact?"
    - panel: 9
      wide: true
      alt: >-
        Arjun writing in a notebook on a hilltop at sunrise. Arjun Uvacha: a
        product manager's perspective of everyday things.

  cards:
    - name: "Blog"
      tagline: "Read"
      description: >-
        Stories and lessons from product work, books, psychology and everyday
        problem-solving.
      link: "/blog/"
      cta: "Read the blog"
      icon: "notebook"
    - name: "AI Lab"
      tagline: "Explore"
      description: >-
        AI products I design, build and ship on the side, from chatbots to
        PromptGym.
      link: "/ai-lab/"
      cta: "Explore the AI Lab"
      icon: "sparkles"
---
