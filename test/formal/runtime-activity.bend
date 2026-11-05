import Base

# New activity reaches a viewer only while the session is attached, the viewer
# is subscribed, and the viewer's binding matches the active session.
# An end notification may still expose previously retained activity.
def can_deliver_activity(attached: Bool, subscribed: Bool, same_binding: Bool) -> Bool:
  match attached subscribed same_binding:
    case True{} True{} True{}:
      True{}
    case _ _ _:
      False{}

law ended_never_delivers:
  for subscribed: Bool
  for same_binding: Bool
  {can_deliver_activity(False{}, subscribed, same_binding) == False{} : Bool}

def ended_never_delivers(subscribed, same_binding):
  match subscribed same_binding:
    case False{} False{}: {==}
    case False{} True{}: {==}
    case True{} False{}: {==}
    case True{} True{}: {==}

law unsubscribed_never_delivers:
  for attached: Bool
  for same_binding: Bool
  {can_deliver_activity(attached, False{}, same_binding) == False{} : Bool}

def unsubscribed_never_delivers(attached, same_binding):
  match attached same_binding:
    case False{} False{}: {==}
    case False{} True{}: {==}
    case True{} False{}: {==}
    case True{} True{}: {==}

law different_binding_never_delivers:
  for attached: Bool
  for subscribed: Bool
  {can_deliver_activity(attached, subscribed, False{}) == False{} : Bool}

def different_binding_never_delivers(attached, subscribed):
  match attached subscribed:
    case False{} False{}: {==}
    case False{} True{}: {==}
    case True{} False{}: {==}
    case True{} True{}: {==}

def main() -> List<Bool>:
  [can_deliver_activity(False{}, False{}, False{}),
   can_deliver_activity(False{}, False{}, True{}),
   can_deliver_activity(False{}, True{}, False{}),
   can_deliver_activity(False{}, True{}, True{}),
   can_deliver_activity(True{}, False{}, False{}),
   can_deliver_activity(True{}, False{}, True{}),
   can_deliver_activity(True{}, True{}, False{}),
   can_deliver_activity(True{}, True{}, True{})]
