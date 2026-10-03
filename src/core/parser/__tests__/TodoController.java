package com.todo.controller;

import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.GetMapping;
import com.todo.service.TodoService;
import com.todo.repository.UserRepository;

@RestController
public class TodoController {
    
    private final TodoService todoService;
    private final UserRepository userRepository;
    
    public TodoController(TodoService todoService, UserRepository userRepository) {
        this.todoService = todoService;
        this.userRepository = userRepository;
    }
    
    @GetMapping("/api/todos")
    public String getTodos() {
        userRepository.findUser();
        return todoService.getTodos();
    }
}
