(define (domain deliveroo-crates)
  (:requirements :typing)

  (:types
    location - object
    agent - object
    crate - object
  )

  (:predicates
    ;; Navigation
    (adjacent ?from ?to - location)
    (clear ?loc - location)
    (agent-at ?a - agent ?loc - location)
    (crate-at ?c - crate ?loc - location)

    ;; Crate properties
    (pushable ?c - crate)
    (on-crate-tile ?loc - location)

    ;; Straight-line push geometry: agent at ?from pushes a crate at ?via
    ;; onto ?to, where ?from -> ?via -> ?to are collinear and consecutive.
    (push-line ?from ?via ?to - location)
  )

  (:action move-empty
    :parameters (?a - agent ?from ?to - location)
    :precondition (and
      (agent-at ?a ?from)
      (adjacent ?from ?to)
      (clear ?to)
    )
    :effect (and
      (not (agent-at ?a ?from))
      (agent-at ?a ?to)
    )
  )

  (:action push-crate
    :parameters (
      ?a - agent
      ?crate - crate
      ?from ?via ?to - location
    )
    :precondition (and
      (agent-at ?a ?from)
      (crate-at ?crate ?via)
      (push-line ?from ?via ?to)
      (on-crate-tile ?via)
      (on-crate-tile ?to)
      (pushable ?crate)
      (clear ?to)
    )
    :effect (and
      (not (agent-at ?a ?from))
      (agent-at ?a ?via)
      (not (crate-at ?crate ?via))
      (crate-at ?crate ?to)
      (clear ?via)
      (not (clear ?to))
    )
  )
)
