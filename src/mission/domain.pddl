(define (domain deliveroo-crates)
  (:requirements :typing)

  (:types
    location - object
    agent - object
  )

  (:predicates
    ;; Navigation
    (adjacent ?from ?to - location)
    (clear ?loc - location)
    (agent-at ?a - agent ?loc - location)

    ;; Crates are anonymous: we only track whether a tile currently holds a
    ;; crate, never which crate. The goal is purely (agent-at ...), so crate
    ;; identity is irrelevant — dropping it removes the ?crate action parameter
    ;; and keeps grounding tractable on dense maps.
    (occupied ?loc - location)
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
      ?from ?via ?to - location
    )
    :precondition (and
      (agent-at ?a ?from)
      (occupied ?via)
      (push-line ?from ?via ?to)
      (on-crate-tile ?to)
      (clear ?to)
    )
    :effect (and
      (not (agent-at ?a ?from))
      (agent-at ?a ?via)
      (not (occupied ?via))
      (clear ?via)
      (occupied ?to)
      (not (clear ?to))
    )
  )
)
